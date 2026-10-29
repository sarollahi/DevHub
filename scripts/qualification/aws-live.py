#!/usr/bin/env python3
"""Run a *real* ephemeral, multi-AZ DevHub native-load qualification over AWS SSM.

No public inbound ports, SSH keys, permanent test credentials, or fabricated
results. Source is pinned to a 40-byte Git commit. All resources belong to a
run-scoped CloudFormation stack and the GitHub workflow always deletes it.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import base64
import json
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path

REPO = "https://github.com/sarollahi/DevHub.git"

def aws(*argv):
    result = subprocess.run(["aws", *argv, "--output", "json"], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("aws " + " ".join(argv[:3]) + ": " + result.stderr[-1500:])
    return json.loads(result.stdout) if result.stdout.strip() else {}

def ssm(instance, script, label, timeout=2100):
    # A single base64 script argument avoids shell escaping and disclosure in
    # the runner log; AWS SSM still keeps command history in the account.
    data = base64.b64encode(("#!/bin/bash\nset -Eeuo pipefail\n" + script + "\n").encode()).decode()
    command = "printf '%s' '" + data + "' | base64 --decode | bash"
    sent = aws("ssm", "send-command", "--instance-ids", instance,
               "--document-name", "AWS-RunShellScript",
               "--comment", "isolated-devhub-" + label,
               "--timeout-seconds", str(min(timeout, 3600)),
               "--parameters", json.dumps({"commands": [command]}))
    command_id = sent["Command"]["CommandId"]
    until = time.monotonic() + timeout + 60
    while time.monotonic() < until:
        try:
            result = aws("ssm", "get-command-invocation", "--instance-id", instance,
                         "--command-id", command_id)
        except RuntimeError:
            time.sleep(3)
            continue
        status = result.get("Status", "")
        if status in ["Success", "Cancelled", "Failed", "TimedOut", "Cancelling"]:
            if status != "Success":
                raise RuntimeError(label + ": " + status + ": " +
                    result.get("StandardErrorContent", "")[-3500:] +
                    " " + result.get("StandardOutputContent", "")[-1500:])
            return result.get("StandardOutputContent", "")
        time.sleep(4)
    raise TimeoutError("SSM timed out: " + label + " on " + instance)

def require_ssm(ids):
    end = time.monotonic() + 600
    while time.monotonic() < end:
        data = aws("ssm", "describe-instance-information", "--filters",
                   "Key=InstanceIds,Values=" + ",".join(ids))
        visible = {i["InstanceId"] for i in data.get("InstanceInformationList", [])
                   if i.get("PingStatus") == "Online"}
        if visible == set(ids):
            return
        time.sleep(10)
    raise TimeoutError("All three hosts failed to register online with Systems Manager")

def make_env(p, role, db_ip, token, signing_pub=None):
    values = {
        "DATABASE_URL": "postgresql://qual:" + p["pg"] + "@" + db_ip + ":5432/devhub?schema=public",
        "REDIS_URL": "redis://" + db_ip + ":6379",
        "OBJECT_STORE_ENDPOINT": "http://" + db_ip + ":9000",
        "OBJECT_STORE_REGION": "us-east-1",
        "OBJECT_STORE_BUCKET": "devhub-qualification",
        "OBJECT_STORE_ACCESS_KEY": "qualification",
        "OBJECT_STORE_SECRET_KEY": p["s3"],
        "APP_SECRET": p["app"],
        "OPS_METRICS_TOKEN": token,
        "DEVHUB_REGION": "aws-" + role,
        "DEVHUB_NODE_ID": role,
        "NEXT_TELEMETRY_DISABLED": "1",
        "DEVHUB_QUALIFICATION_ISOLATED": "YES",
        "DEVHUB_QUALIFICATION_APPROVAL": "RUN_FULL_SCALE",
    }
    if signing_pub:
        values["VALIDATION_SIGNING_PUBLIC_KEY"] = signing_pub
    if not all(re.fullmatch(r"[a-zA-Z0-9_:/?=.+-]+", v) for v in values.values()):
        raise ValueError("Environment value contains unsafe shell metacharacters")
    return "".join(k + "=" + v + "\n" for k, v in values.items())

def checkout(sha):
    return ("if [ ! -d /opt/devhub/.git ]; then git clone --quiet --no-checkout " +
            REPO + " /opt/devhub; fi\n" +
            "git -C /opt/devhub fetch --quiet origin " + sha + "\n" +
            "git -C /opt/devhub checkout --quiet --detach " + sha + "\n" +
            "cd /opt/devhub\n" +
            "npm ci --ignore-scripts --no-audit --no-fund\n" +
            "npm run db:generate\n")

def service(name, command):
    # systemd services own their work after SSM RunShellScript terminates.
    return ("cat > /etc/systemd/system/devhub-" + name + ".service <<'EOF'\n"
            "[Unit]\nDescription=Disposable DevHub " + name + "\nAfter=network-online.target\n"
            "[Service]\nType=simple\nWorkingDirectory=/opt/devhub\n"
            "EnvironmentFile=/etc/devhub-qualification.env\n"
            "ExecStart=/usr/bin/npm run " + command + "\n"
            "Restart=on-failure\nRestartSec=2\n"
            "[Install]\nWantedBy=multi-user.target\nEOF\n"
            "systemctl daemon-reload\n"
            "systemctl enable --now devhub-" + name + ".service\n")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stack", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--changesets", type=int, default=240)
    args = parser.parse_args()
    if os.getenv("DEVHUB_QUALIFICATION_ISOLATED") != "YES" or not re.fullmatch(r"[a-f0-9]{40}", args.sha):
        raise ValueError("Only isolated runs with an immutable 40-byte Git SHA are allowed")
    if not 24 <= args.changesets <= 1000:
        raise ValueError("Bound the multi-host smoke to 24..1000 per client; full 1m is separate")
    stack = aws("cloudformation", "describe-stacks", "--stack-name", args.stack)["Stacks"][0]
    if stack["StackStatus"] != "CREATE_COMPLETE":
        raise RuntimeError("Disposable stack did not provision successfully")
    outputs = {x["OutputKey"]: x["OutputValue"] for x in stack["Outputs"]}
    ids = [outputs["DriverId"], outputs["ApiAId"], outputs["ApiBId"]]
    ips = [outputs["DriverPrivateIp"], outputs["ApiAPrivateIp"], outputs["ApiBPrivateIp"]]
    if len(set(ids)) != 3 or len(set(ips)) != 3 or outputs["ApiAZone"] == outputs["ApiBZone"]:
        raise RuntimeError("Physical multi-host and independent-AZ topology not established")
    evidence = Path(args.evidence)
    evidence.mkdir(parents=True, exist_ok=True)
    require_ssm(ids)
    attestation = []
    for index, instance in enumerate(ids):
        out = ssm(instance,
            "node -e 'const os=require(\"os\"); const fs=require(\"fs\"); "
            "console.log(JSON.stringify({host:os.hostname(),boot:"
            "fs.readFileSync(\"/proc/sys/kernel/random/boot_id\",\"utf8\").trim()}))'\n",
            "attest-host-" + str(index), timeout=180)
        data = json.loads(out.strip().splitlines()[-1])
        attestation.append(dict(role=["driver","api-a","api-b"][index],
                                instance=instance, address=ips[index],
                                zone=[outputs["DriverZone"],outputs["ApiAZone"],
                                      outputs["ApiBZone"]][index], **data))
    if len({h["boot"] for h in attestation}) != 3:
        raise RuntimeError("Multiple EC2 IDs did not prove separate physical kernel identities")
    (evidence / "hosts.json").write_text(json.dumps(attestation, indent=2) + "\n")
    print(json.dumps({"hostAttestation":"PASSED","nodes":3,"apiAvailabilityZones":2}), flush=True)

    p = {name: secrets.token_hex(22) for name in ("pg","s3","app")}
    metrics_token = secrets.token_hex(32)
    db_ip = ips[0]
    driver_env = make_env(p,"driver",db_ip,metrics_token)
    services = (
        "docker run -d --name devhub-qual-postgres --network host "
        "-e POSTGRES_USER=qual -e POSTGRES_PASSWORD=" + p["pg"] +
        " -e POSTGRES_DB=devhub postgres:16-alpine\n"
        "docker run -d --name devhub-qual-redis --network host redis:7-alpine\n"
        "docker run -d --name devhub-qual-minio --network host "
        "-e MINIO_ROOT_USER=qualification -e MINIO_ROOT_PASSWORD=" + p["s3"] +
        " cgr.dev/chainguard/minio:latest server /data\n"
        "for i in $(seq 1 60); do docker exec devhub-qual-postgres pg_isready -U qual -d devhub && break; sleep 3; done\n"
        "docker run --rm --network host --entrypoint /bin/sh "
        "-e STORE_USER=qualification -e STORE_PASSWORD=" + p["s3"] +
        " cgr.dev/chainguard/minio-client:latest-dev -ec "
        "'until mc alias set local http://127.0.0.1:9000 \"$STORE_USER\" \"$STORE_PASSWORD\"; "
        "do sleep 2; done; mc mb --ignore-existing local/devhub-qualification'\n"
    )
    ssm(ids[0], checkout(args.sha) +
        "cat > /etc/devhub-qualification.env <<'EOT'\n" + driver_env + "EOT\n"
        "chmod 600 /etc/devhub-qualification.env\n" + services +
        "set -a; source /etc/devhub-qualification.env; set +a\n"
        "npm run db:deploy\n", "bootstrap-driver", timeout=1500)

    for index in (1,2):
        role = "api-a" if index == 1 else "api-b"
        api_env = make_env(p,role,db_ip,metrics_token)
        api_boot = checkout(args.sha) + (
            "cat > /etc/devhub-qualification.env <<'EOT'\n" + api_env + "EOT\n"
            "chmod 600 /etc/devhub-qualification.env\n"
            "set -a; source /etc/devhub-qualification.env; set +a\n"
            "npm run build\n"
            )
        api_boot += service("api", "start -- -H 0.0.0.0 -p 3000")
        for short, cmd in [("index","worker:source-index"),("review","worker:review"),
                           ("integration","worker:integration")]:
            api_boot += service(short,cmd)
        ssm(ids[index], api_boot, "bootstrap-" + role, timeout=1600)
    origin_list = ",".join("http://" + ip + ":3000" for ip in ips[1:])
    readiness = (
        "for origin in " + " ".join("http://" + ip + ":3000" for ip in ips[1:]) + "; do\n"
        "  ready=0; for i in $(seq 1 60); do if curl -fsS \"$origin/api/health\" > /dev/null; "
        "then ready=1; break; fi; sleep 3; done\n"
        "  test \"$ready\" = 1\n"
        "  curl -fsS -H 'Authorization: Bearer " + metrics_token +
        "' \"$origin/api/ops/identity\"\n"
        "done\n"
    )
    identity = ssm(ids[0],readiness,"api-health-and-identity",timeout=330)
    observed = [json.loads(line) for line in identity.splitlines() if line.startswith("{")]
    if len(observed)!=2 or len({x.get("instanceId") for x in observed})!=2 or (
        len({x.get("physicalHostFingerprint") for x in observed})!=2
    ):
        raise RuntimeError("Live remote APIs failed authenticated physical-host attestation")
    (evidence/"api-instances.json").write_text(json.dumps(observed,indent=2)+"\n")
    print(json.dumps({"remoteApiAttestation":"PASSED","replicas":2}),flush=True)

    workload = (
        "cd /opt/devhub\n"
        "set -a; source /etc/devhub-qualification.env; set +a\n"
        "export DEVHUB_ALLOW_EXTERNAL_PROBES=yes\n"
        "mkdir -p /tmp/qualification/evidence\n"
        "node scripts/certify-multi-process.mjs "
        "--clients=3 --changesets=" + str(args.changesets) +
        " --submissions=24 --concurrency=24 --timeout-seconds=1500 "
        "--api=" + origin_list + " "
        "--output=/tmp/qualification/evidence > /tmp/qualification/evidence/driver.stdout.log 2> /tmp/qualification/evidence/driver.stderr.log\n"
        "python3 - <<'PY'\n"
        "import json\n"
        "x=json.load(open('/tmp/qualification/evidence/summary.json'))\n"
        "assert x['status']=='PASS'\n"
        "assert x['workload']['totalPersistedChangesets']==" + str(3*args.changesets) + "\n"
        "assert len(x['probes'])==2 and all(v['errors']==0 for v in x['probes'].values())\n"
        "print(json.dumps({'status':'PASS','committed':x['workload']['totalPersistedChangesets'],"
        "'p95ByOrigin':{k:v['p95Ms'] for k,v in x['probes'].items()}}))\n"
        "PY\n"
        "aws s3 cp /tmp/qualification/evidence/ "
        "s3://" + outputs["EvidenceBucket"] + "/multi-host/ --recursive --quiet\n"
    )
    outcome = ssm(ids[0],workload,"multi-node-native-source-control",timeout=1750)
    stats = [json.loads(line) for line in outcome.splitlines() if line.startswith("{")]
    if not any(x.get("status")=="PASS" and x.get("committed")==3*args.changesets for x in stats):
        raise RuntimeError("Real multi-host workload completed without an independently verifiable PASS")
    (evidence/"measured-summary.json").write_text(json.dumps(stats[-1],indent=2)+"\n")
    # Real writers now run on each *distinct physical host*, not only in
    # independent child processes of the driver. All share the same real DB/S3.
    def remote_writer(i):
        role = ["driver","api-a","api-b"][i]
        count = args.changesets
        remote = "/tmp/qualification/multi-writers/" + role
        work = (
            "cd /opt/devhub\\n"
            "set -a; source /etc/devhub-qualification.env; set +a\\n"
            "mkdir -p " + remote + "\\n"
            "node --import tsx scripts/bench-lifecycle.ts "
            "--submissions=24 --changesets=" + str(count) +
            " --concurrency=24 --depth=16 --monorepo-paths=32 "
            "--ref-writers=12 --integration-jobs=4 --ci-jobs=0 "
            "--queries=12 --blobs=5 "
            "--output=" + remote + "/lifecycle.json "
            "> " + remote + "/stdout.log 2> " + remote + "/stderr.log\\n"
            "python3 - <<'PY'\\n"
            "import json\\n"
            "x=json.load(open('" + remote + "/lifecycle.json'))\\n"
            "assert x['integrity']['persistedAfterIndependentPhase']==" + str(count + 1) + "\\n"
            "assert x['phases']['concurrent_change_submissions']['completed']==24\\n"
            "print(json.dumps({'status':'PASS','runId':x['runId'],"
            "'persisted':x['integrity']['persistedAfterIndependentPhase'],"
            "'p95Ms':x['phases']['concurrent_change_submissions']['p95Ms']}))\\n"
            "PY\\n"
            "aws s3 cp " + remote + "/ s3://" + outputs["EvidenceBucket"] +
            "/real-writers/" + role + "/ --recursive --quiet\\n"
        )
        output = ssm(ids[i],work,"live-physical-writer-"+role,timeout=1500)
        row = [json.loads(x) for x in output.splitlines() if x.startswith("{")]
        if not row or row[-1].get("status")!="PASS":
            raise RuntimeError("No verified durable native publication on "+role)
        return {"role":role,"host":attestation[i]["host"],
                "instanceId":ids[i],**row[-1]}

    writes=[]
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs=[pool.submit(remote_writer,i) for i in range(3)]
        for job in as_completed(jobs):
            writes.append(job.result())
    if len(writes)!=3 or len({r["host"] for r in writes})!=3 or (
        len({r["runId"] for r in writes})!=3 or
        not all(r["persisted"]==args.changesets+1 for r in writes)
    ):
        raise RuntimeError("Cross-host native writers did not independently persist and verify content")
    (evidence/"physical-writers.json").write_text(json.dumps(writes,indent=2)+"\\n")
    print(json.dumps({"qualification":"MEASURED_MULTI_HOST_NATIVE_PUBLICATION",
        "writersOnSeparateKernels":len(writes),
        "persistedIndependentRevisions":len(writes)*args.changesets,
        "fullEndToEndCertification":False,
        "note":"Actual native DB/content writers ran on 3 hosts; HTTP probes are separately only health/identity"}),flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"qualification":"FAILED","reason":str(error)}),file=sys.stderr)
        sys.exit(1)
