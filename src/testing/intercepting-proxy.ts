import { connect, createServer, type Server, type Socket } from "node:net";

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import {
  Array as EffectArray,
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Ref,
  String as EffectString,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readOutput } from "../clients/process";
import { formatJson } from "../json";
import { scratchDirectory } from "./scratch-process";

/** A request the proxy received inside a tunnel. */
export interface InterceptedRequest {
  /** The request's body as text, empty where it has none. */
  readonly body: string;
  readonly method: string;
  readonly path: string;
}

/** An answer with a status other than 200, which `respond` returns in place of bare JSON. */
export class Reply {
  public readonly body: unknown;
  public readonly status: number;

  public constructor(status: number, body: unknown) {
    this.body = body;
    this.status = status;
  }
}

// Each host's certificate and key, made once per process, since openssl is slow.
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

// Listens on a free loopback port and returns it. The scope runs `beforeClose`, then closes the
// server.
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
 * A proxy that answers HTTPS requests to one host itself, as a sandbox's proxy does. Inside each
 * CONNECT tunnel, it answers with a self-signed certificate for the host.
 */
export class InterceptingProxy extends Context.Service<
  InterceptingProxy,
  {
    /** Answers each later request with the JSON or the `Reply` that `respond` returns. */
    readonly answer: (respond: (request: InterceptedRequest) => unknown) => Effect.Effect<void>;
    /** The proxy's certificate in PEM, which a client trusts as its certificate authority. */
    readonly ca: string;
    /** A file holding `ca`. */
    readonly caFile: string;
    /** Each CONNECT and request, in order, as `CONNECT host:port` or `GET host/path`. */
    readonly log: Effect.Effect<readonly string[]>;
    /** Each request received inside a tunnel, in order. */
    readonly requests: Effect.Effect<readonly InterceptedRequest[]>;
    readonly url: string;
  }
>()("jj-octo/testing/intercepting-proxy/InterceptingProxy") {}

/**
 * A proxy for the host, which answers each request with GitHub's 404 until a test calls `answer`.
 */
export const interceptingProxy = (
  host: string,
): Layer.Layer<
  InterceptingProxy,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    InterceptingProxy,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cert, key } = yield* certificateFor(host);
      const directory = yield* scratchDirectory("proxy-");
      const caFile = path.join(directory, "ca.pem");
      yield* Effect.orDie(fs.writeFileString(caFile, cert));
      const log = yield* Ref.make<readonly string[]>([]);
      const responder = yield* Ref.make<(request: InterceptedRequest) => unknown>(
        () => new Reply(404, { message: "Not Found" }),
      );
      const requests = yield* Ref.make<readonly InterceptedRequest[]>([]);
      const record = (line: string) => Ref.update(log, EffectArray.append(line));
      const port = yield* serveOrigin({
        cert,
        key,
        record: (line, request) =>
          record(line).pipe(Effect.andThen(Ref.update(requests, EffectArray.append(request)))),
        respond: Ref.get(responder),
      });
      // The proxy records each CONNECT from a socket's callback, outside any fiber.
      const context = yield* Effect.context();
      const runSync = Effect.runSyncWith(context);
      const proxy = proxyServer(port, (line) => {
        runSync(record(line));
      });
      const proxyPort = yield* listen(proxy.server, proxy.destroySockets);
      return {
        answer: (respond) => Ref.set(responder, respond),
        ca: cert,
        caFile,
        log: Ref.get(log),
        requests: Ref.get(requests),
        url: `http://127.0.0.1:${proxyPort}`,
      };
    }),
  );

// The HTTPS server inside the tunnel. Returns its port, and stops with the scope.
const serveOrigin = ({
  cert,
  key,
  record,
  respond,
}: {
  readonly cert: string;
  readonly key: string;
  readonly record: (line: string, request: InterceptedRequest) => Effect.Effect<void>;
  readonly respond: Effect.Effect<(request: InterceptedRequest) => unknown>;
}) =>
  Effect.gen(function* () {
    const server = yield* Effect.orDie(
      BunHttpServer.make({ hostname: "127.0.0.1", port: 0, tls: { cert, key } }),
    );
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const received = { body: yield* request.text, method: request.method, path: request.url };
        yield* record(`${request.method} ${request.headers["host"] ?? ""}${request.url}`, received);
        const responder = yield* respond;
        const answer = responder(received);
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

// Tunnels each CONNECT to the origin's port. A TCP server has no `closeAllConnections`, so it keeps
// both ends of each tunnel for `destroySockets`. Otherwise the origin's graceful stop never ends.
const proxyServer = (port: number, record: (line: string) => void) => {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => {
      sockets.delete(client);
    });
    let head = "";
    // A client that rejects the certificate resets the tunnel, which isn't the proxy failing.
    client.on("error", () => {
      client.destroy();
    });
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = EffectString.indexOf("\r\n\r\n")(head);
      if (Option.isNone(end)) {
        return;
      }
      // Paused until `pipe` resumes it, so no bytes are lost while the tunnel connects.
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
