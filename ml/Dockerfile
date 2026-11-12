# The Isolation Forest scoring sidecar (worker/server.py). Python matches the
# version CI tests against; the libraries are the exact pins in
# requirements.txt, which the model/feature versions on findings assume.
FROM python:3.14-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip check
COPY worker/server.py .

USER nobody
EXPOSE 8321
# 0.0.0.0 inside the container only: compose publishes no port, so the
# sidecar is reachable on the internal network and nowhere else.
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8321"]
