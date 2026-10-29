# Real offline vulnerability and misconfiguration scanner for isolated validation.
# Build on a networked disposable CI runner. The runtime scanner has no network.
FROM aquasec/trivy:0.67.2
USER root
ENV TRIVY_CACHE_DIR=/opt/trivy-cache
RUN mkdir -p "$TRIVY_CACHE_DIR" \
  && trivy image --cache-dir "$TRIVY_CACHE_DIR" --download-db-only \
  && chmod -R a+rX "$TRIVY_CACHE_DIR"
# The runner sets --entrypoint /bin/sh, --network=none and --user=65534.
# A missing DB fails the SECURITY/DEPENDENCIES task; never fabricate success.
