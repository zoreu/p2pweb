from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json

class MeuHandler(BaseHTTPRequestHandler):

    def _set_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        resposta = {
            "rota": parsed.path,
            "parametros": params
        }

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._set_cors_headers()
        self.end_headers()

        self.wfile.write(
            json.dumps(resposta, indent=2, ensure_ascii=False).encode("utf-8")
        )

    def do_POST(self):
        tamanho = int(self.headers.get("Content-Length", 0))
        corpo = self.rfile.read(tamanho).decode("utf-8")

        resposta = {
            "metodo": "POST",
            "body": corpo
        }

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._set_cors_headers()
        self.end_headers()

        self.wfile.write(
            json.dumps(resposta, indent=2, ensure_ascii=False).encode("utf-8")
        )

if __name__ == "__main__":
    servidor = HTTPServer(("0.0.0.0", 8080), MeuHandler)
    print("Servidor iniciado em http://0.0.0.0:8080")
    servidor.serve_forever()