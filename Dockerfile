FROM ghcr.io/zastinian/esdock:nodejs_22

USER root
RUN apt-get update \
  && apt-get install -y samba smbclient samba-common-bin fuse3 libfuse3-dev libfuse2 \
     gosu sudo python3 python3-pip ffmpeg make g++ pkg-config \
  && python3 -m pip install --no-cache-dir --break-system-packages "faster-whisper==1.1.1" \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

RUN echo "user_allow_other" > /etc/fuse.conf \
  && echo "#101 ALL=(root) NOPASSWD: /home/container/tools/smb_user.sh" > /etc/sudoers.d/offload \
  && chmod 440 /etc/sudoers.d/offload
