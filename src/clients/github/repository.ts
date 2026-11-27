import { Option, String as EffectString } from "effect";

/** Owner and name of a GitHub repository. */
export interface Repository {
  readonly name: string;
  readonly owner: string;
}

export const repositoryFromUrl = (url: string): Option.Option<Repository> => {
  const match = /github\.com[:/](?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?\/?$/u.exec(
    EffectString.trim(url),
  );
  const owner = match?.groups?.["owner"];
  const name = match?.groups?.["name"];
  return owner === undefined || name === undefined ? Option.none() : Option.some({ name, owner });
};
