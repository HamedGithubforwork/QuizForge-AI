# Production builds supply a reviewed docker.io/library/caddy@sha256 digest.
ARG CADDY_BASE_IMAGE
FROM ${CADDY_BASE_IMAGE}
# The official binary requests NET_BIND_SERVICE. Our container listens on
# 8080/8443 with every capability dropped; remove the unneeded file capability.
RUN setcap -r /usr/bin/caddy
USER 10001:10001
