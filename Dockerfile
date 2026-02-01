FROM ghcr.io/zastinian/esdock:nodejs_22

USER root
RUN apt-get update \
  && apt-get install -y samba smbclient samba-common-bin fuse3 gosu \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
