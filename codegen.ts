import type { CodegenConfig } from "@graphql-codegen/cli";

// Types the GraphQL documents in `src` against GitHub's published schema. The output is checked
// in, and `bun run check:codegen` fails where it is out of date. The bundle gets only each
// document's text, since `documentMode: "string"` writes documents as strings, not syntax trees.
const config: CodegenConfig = {
  documents: ["src/**/*.ts", "!src/clients/github/graphql/**"],
  generates: {
    "src/clients/github/graphql/": {
      config: {
        documentMode: "string",
        enumsAsTypes: true,
        onlyOperationTypes: true,
        useTypeImports: true,
      },
      preset: "client",
      presetConfig: { fragmentMasking: false },
    },
  },
  ignoreNoDocuments: false,
  schema: "node_modules/@octokit/graphql-schema/schema.graphql",
};

export default config;
