import { Effect, Option, Stream } from "effect";
import { HttpClientRequest } from "effect/http";

const PAGE_SIZE = 100;

/**
 * Every item of a listing GitHub sends in pages. `read` sends `request` for one page, with
 * `per_page` and `page` set on it. Pages are read in order, until one comes back short.
 */
export const everyPage = <A, E>(
  request: HttpClientRequest.HttpClientRequest,
  read: (pageRequest: HttpClientRequest.HttpClientRequest) => Effect.Effect<readonly A[], E>,
): Effect.Effect<readonly A[], E> =>
  Stream.paginate(1, (page) =>
    read(
      request.pipe(
        HttpClientRequest.setUrlParam("per_page", String(PAGE_SIZE)),
        HttpClientRequest.setUrlParam("page", String(page)),
      ),
    ).pipe(
      Effect.map(
        (items) =>
          [items, items.length < PAGE_SIZE ? Option.none() : Option.some(page + 1)] as const,
      ),
    ),
  ).pipe(Stream.runCollect);
