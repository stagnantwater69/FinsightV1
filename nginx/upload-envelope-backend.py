from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(204)
        self.send_header("X-FinSight-Envelope-Probe", "reached-backend")
        self.end_headers()

    def do_POST(self) -> None:
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            complete = self.read_chunked_body()
        else:
            complete = self.read_sized_body()

        if not complete:
            self.send_response(400)
        else:
            self.send_response(204)
            self.send_header("X-FinSight-Envelope-Probe", "reached-backend")
        self.end_headers()

    def read_sized_body(self) -> bool:
        remaining = int(self.headers.get("Content-Length", "0"))
        while remaining:
            chunk = self.rfile.read(min(remaining, 1024 * 1024))
            if not chunk:
                return False
            remaining -= len(chunk)
        return True

    def read_chunked_body(self) -> bool:
        while True:
            size_line = self.rfile.readline()
            try:
                size = int(size_line.split(b";", 1)[0], 16)
            except ValueError:
                return False
            if size == 0:
                while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                    pass
                return True
            remaining = size
            while remaining:
                chunk = self.rfile.read(min(remaining, 1024 * 1024))
                if not chunk:
                    return False
                remaining -= len(chunk)
            if self.rfile.read(2) != b"\r\n":
                return False

    def log_message(self, _format: str, *_args: object) -> None:
        return


ThreadingHTTPServer(("0.0.0.0", 4000), Handler).serve_forever()
