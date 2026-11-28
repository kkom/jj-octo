import { connect, createServer, type Server, type Socket } from "node:net";

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import {
  Array as EffectArray,
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  String as EffectString,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readOutput } from "../clients/process";
import { formatJson } from "../json";
import { scratchDirectory } from "./scratch-process";

/**
 * A proxy that answers HTTPS requests to one host itself, as a sandbox's proxy does. It accepts
 * each CONNECT, and answers inside the tunnel with a self-signed certificate for the host.
 */
export interface InterceptingProxy {
  /** The proxy's certificate, in PEM, which a client trusts as its certificate authority. */
  readonly ca: string;
  /** A file holding `ca`. */
  readonly caFile: string;
  readonly url: string;
}

/** A request the proxy received inside a tunnel. */
export interface InterceptedRequest {
  /** The request's body as text, empty where it has none. */
  readonly body: string;
  readonly method: string;
  readonly path: string;
}

/** An answer with a status other than 200, which `respond` returns in place of the JSON alone. */
export class Reply {
  public readonly body: unknown;
  public readonly status: number;

  public constructor(status: number, body: unknown) {
    this.body = body;
    this.status = status;
  }
}

// Each host's certificate and key, made once per process, since openssl takes a while.
const certificates = new Map<string, { readonly cert: string; readonly key: string }>();

const certificateFor = (
  host: string,
): Effect.Effect<
  { readonly cert: string; readonly key: string },
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const known = certificates.get(host);
      if (known !== undefined) {
        return known;
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* scratchDirectory("certificate-");
      const args = [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        "key.pem",
        "-out",
        "cert.pem",
        "-days",
        "1",
        "-subj",
        `/CN=${host}`,
        "-addext",
        `subjectAltName=DNS:${host}`,
      ];
      const { exitCode, stderr } = yield* Effect.scoped(
        Effect.flatMap(
          spawner.spawn(ChildProcess.make("openssl", args, { cwd: directory, stdin: "ignore" })),
          readOutput,
        ),
      ).pipe(Effect.orDie);
      if (exitCode !== 0) {
        return yield* Effect.die(new Error(`openssl failed:\n${stderr}`));
      }
      const read = (file: string) => Effect.orDie(fs.readFileString(path.join(directory, file)));
      const made = { cert: yield* read("cert.pem"), key: yield* read("key.pem") };
      certificates.set(host, made);
      return made;
    }),
  );

// Listens on a free port of the loopback address, and returns the port. The scope closes the
// server, after `beforeClose` has ended the connections it holds open.
const listen = (server: Server, beforeClose: () => void) =>
  Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      const onError = (error: Readonly<Error>) => {
        resume(Effect.die(error));
      };
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        resume(
          address === null || typeof address === "string"
            ? Effect.die(new Error(`expected a TCP address, got ${String(address)}`))
            : Effect.succeed(address.port),
        );
      });
    }),
    () =>
      Effect.callback<undefined>((resume) => {
        beforeClose();
        server.close(() => {
          resume(Effect.undefined);
        });
      }),
  );

/**
 * Runs `run` against a proxy that answers each request to the host with the JSON `respond`
 * returns, or the `Reply`. Returns its result, and each CONNECT and request the proxy received, in
 * order, as `CONNECT host:port` or `GET host/path`.
 */
export const throughProxy = <A, E, R>(
  host: string,
  respond: (request: InterceptedRequest) => unknown,
  run: (proxy: InterceptingProxy) => Effect.Effect<A, E, R>,
): Effect.Effect<
  { readonly log: readonly string[]; readonly result: A },
  E,
  R | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cert, key } = yield* certificateFor(host);
      const directory = yield* scratchDirectory("proxy-");
      const caFile = path.join(directory, "ca.pem");
      yield* Effect.orDie(fs.writeFileString(caFile, cert));
      const log: string[] = [];
      const record = (line: string) => {
        log.push(line);
      };
      const port = yield* serveOrigin({ cert, key, record, respond });
      const proxy = proxyServer(port, record);
      const proxyPort = yield* listen(proxy.server, proxy.destroySockets);
      const result = yield* run({ ca: cert, caFile, url: `http://127.0.0.1:${proxyPort}` });
      return { log: [...log], result };
    }),
  );

// The HTTPS server inside the tunnel, which records each request and answers it as `respond` does.
// It returns the server's port, and stops with the scope.
const serveOrigin = ({
  cert,
  key,
  record,
  respond,
}: {
  readonly cert: string;
  readonly key: string;
  readonly record: (line: string) => void;
  readonly respond: (request: InterceptedRequest) => unknown;
}) =>
  Effect.gen(function* () {
    const server = yield* Effect.orDie(
      BunHttpServer.make({ hostname: "127.0.0.1", port: 0, tls: { cert, key } }),
    );
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        record(`${request.method} ${request.headers["host"] ?? ""}${request.url}`);
        const answer = respond({
          body: yield* request.text,
          method: request.method,
          path: request.url,
        });
        const { body, status } = answer instanceof Reply ? answer : new Reply(200, answer);
        return HttpServerResponse.text(formatJson(body), {
          contentType: "application/json",
          status,
        });
      }).pipe(Effect.orDie),
    );
    return yield* Match.value(server.address).pipe(
      Match.tag("UnixPathAddress", ({ path }) =>
        Effect.die(new Error(`expected a TCP address, got ${path}`)),
      ),
      Match.tag("InetAddressV4", "InetAddressV6", ({ port }) => Effect.succeed(port)),
      Match.exhaustive,
    );
  });

// The proxy, which records each CONNECT and tunnels it to the origin's port. A plain TCP server has
// no `closeAllConnections`, so it keeps both ends of each tunnel for `destroySockets` to close.
// The origin then has no connection left when its scope stops it, so its graceful stop ends.
const proxyServer = (port: number, record: (line: string) => void) => {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => {
      sockets.delete(client);
    });
    let head = "";
    // A client that rejects the certificate resets the tunnel, which is no failure of the proxy.
    client.on("error", () => {
      client.destroy();
    });
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = EffectString.indexOf("\r\n\r\n")(head);
      if (Option.isNone(end)) {
        return;
      }
      // Paused until `pipe` resumes it, so no bytes go by while the tunnel connects.
      client.pause();
      client.off("data", onData);
      const [method, target] = EffectString.split(
        EffectArray.headNonEmpty(EffectString.split(head, "\r\n")),
        " ",
      );
      record(`${method} ${target}`);
      const tunnel = connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        tunnel.write(Buffer.from(EffectString.slice(end.value + 4)(head), "latin1"));
        client.pipe(tunnel);
        tunnel.pipe(client);
      });
      sockets.add(tunnel);
      tunnel.on("close", () => {
        sockets.delete(tunnel);
      });
      tunnel.on("error", () => {
        client.destroy();
      });
    };
    client.on("data", onData);
  });
  const destroySockets = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  };
  return { destroySockets, server };
};
