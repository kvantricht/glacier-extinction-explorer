import http.server
import os
import sys


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isfile(path) and "Range" in self.headers:
            try:
                rng = self.headers["Range"].strip().replace("bytes=", "")
                start, end = rng.split("-")
                f = open(path, "rb")
                fs = os.fstat(f.fileno()).st_size
                start = int(start) if start else 0
                end = int(end) if end else fs - 1
                end = min(end, fs - 1)
                length = end - start + 1
                f.seek(start)
                self.send_response(206)
                self.send_header("Content-type", self.guess_type(path))
                self.send_header("Content-Range", f"bytes {start}-{end}/{fs}")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return f
            except Exception as e:
                pass
        return super().send_head()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # suppress per-request noise


os.chdir(r"C:\Users\VTRICHTK\OneDrive - VITO\Documents\git\GlacierViz")
http.server.test(HandlerClass=RangeHandler, port=4173, bind="127.0.0.1")
