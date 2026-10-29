# Disposable real multi-host AWS qualification

This is an **operator-authorized, billable, live three-EC2-host test**, not a
mocked GitHub Actions matrix. API A and API B occupy **different AWS availability
zones**; all three machine boot IDs and API instance identities are observed.
The driver runs real canonical PostgreSQL-backed changeset submissions while
the two remote APIs and distributed index/review/integration workers remain
running on separate hosts. Native benchmark HTTP probes measure API health,
**not business-request latency**. The returned evidence cannot by itself
certify the entire full-scale, signed-validation, regional-cache or
managed-database failover program.

## One-time AWS authorization

The GitHub app's repository access alone **does not grant an AWS account or
permission to incur EC2 costs**. An owner of a separate AWS account must first
create an IAM OIDC identity provider for `token.actions.githubusercontent.com`,
and a GitHub Actions role with `aud=sts.amazonaws.com` and a **strict,
exact-match** `sub` scoped to this repository and the
`devhub-performance-isolated` GitHub environment. The subject may include
repository numeric IDs on repositories created in 2026; inspect the actual
GitHub token claims rather than blindly using an old example.

This role must be allowed to create and delete the disposable CloudFormation
stack, pass an appropriate *CloudFormation service role* restricted to the
qualification stack, use SSM Run Command on its run-tagged EC2 instances, and
list/get/delete the evidence in its generated S3 bucket. CloudFormation needs
scoped rights to create EC2, VPC networking, S3 and the SSM instance IAM
profile. Configure a service role and resource restrictions appropriate to
the account. **Do not** attach AdministratorAccess, provide access keys in
repository files, accept arbitrary untrusted pull-request events, or deploy in
an account holding production customer data.

Set the protected GitHub environment variables:

- `DEVHUB_PERF_AWS_ROLE_ARN`: the exact role ARN approved for this workflow.
- `DEVHUB_PERF_AWS_REGION`: a supported region with at least two AZs, EC2
  `m7i` or `m6i` capacity, and SSM enabled.

GitHub Actions uses short-lived OIDC credentials via
`aws-actions/configure-aws-credentials@v4`; no permanent AWS key is stored.

## Provision / measure / destroy

Choose **Actions → Provision and qualify disposable AWS multi-host lab →
Run workflow**, branch `feature/end-to-end-scale-qualification`. Supply the
explicit confirmation `PROVISION_ISOLATED_AWS_AND_ACCEPT_COST`. The default
provisions three m7i.large instances with encrypted, delete-on-termination
80-GiB gp3 volumes. Sizes and workload are bounded by workflow choices. The
driver, API A and API B get **distinct EC2 instance IDs**; APIs are placed in
separate AZs. There are no public inbound ports or SSH key pairs. Systems
Manager is used for control and collection. Subnets use public IPs **only for
outbound downloads and SSM**, with inbound denied by the security group.

The test verifies actual Linux kernel boot fingerprints from all machines,
then authenticates against the two real remote API processes. It requires
three distinct kernels, two distinct API identities, different AZs, and
health/readiness with zero observed errors during independent, real
source-control publication workloads. Output contains persisted changeset
counts, driver phase latency distributions, API probe samples and errors,
host attestations, and raw driver logs. Artifacts are downloaded from a private
encrypted S3 bucket and uploaded to the workflow, **even on failure where
available**.

The workflow has an `if: always()` deletion stage for the bucket and entire
CloudFormation stack. As a second safety guard, every EC2 host schedules
self-shutdown after 150 minutes and is configured to **terminate** on shutdown;
its encrypted root disk is deleted. The bucket also expires objects after one
day. If a workflow is killed mid-run, an operator must still check that the
CloudFormation stack was destroyed; the self-termination guard does **not**
remove leftover VPC/IAM/S3 stack metadata or non-instance resources.

**Cost:** Three EC2 instances, encrypted EBS storage, public IPv4 addresses,
S3 requests, and associated network traffic are billable. This workflow
intentionally cannot trigger from `push` or `pull_request`.

## Certification boundary

This closes the *repeatable multi-host provisioning and launch path*. A
successful run would establish actual machine separation and a measured
multi-host **native publication smoke**, not complete production-equivalent
certification. The 1,000/10,000/100,000/1,000,000 full workload, **signed OCI
CI and final sync under remote node faults**, real regional cache, all-node
resources, multi-node DB failover, and sustained/repeated comparisons still
need their own measured evidence and explicit qualification gates. The
separate `native-scale-lab.yml` can exercise 100k/1m on one GitHub runner,
but must not be labeled a physical multi-node execution.

If the OIDC role has not been authorized, this workflow stops **before
provisioning**. The GitHub connector cannot authorize an AWS account or decide
to incur charges for its owner. Do not mark an unexecuted infrastructure
declaration as a passing benchmark.
