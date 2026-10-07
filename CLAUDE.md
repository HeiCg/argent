# argent

## Documentation

The docs site lives in `packages/docs/` and is published to docs.swmansion.com/argent.
See `packages/docs/CLAUDE.md` for writing style, front matter and checks.

The site documents two products. Argent, the toolkit in this repository, lives at the
root of `packages/docs/docs/`. Argent Cloud lives in `packages/docs/docs/cloud/`. The paths
below refer to the toolkit.

Update the docs in the same pull request as the change:

- MCP tools, CLI, config keys, flow files -> the matching page in
  `packages/docs/docs/reference/`, plus `docs/features/` if the user facing capability
  changed.
- Install, platforms, editor setup, telemetry -> `packages/docs/docs/fundamentals/`.
- A new capability -> a `features/` page and a `reference/` entry.

If no docs update is needed, say so in the pull request description.

After editing docs, run `npx docusaurus build` in `packages/docs/` and `npm run format` from the
repo root.

<!-- demerzel:begin -->
## Demerzel

O estado de entrega deste projeto vive em `.demerzel/` (plano, journal,
evidência, memória) e só o CLI `demerzel` escreve nele — nunca edite à
mão. Trabalhe pelo ciclo `/demerzel` (plan init, plan approve, step start,
review, approve, commit). A memória do projeto entra no SessionStart;
anote decisões com `demerzel memory note "<uma linha>"`.

Antes de perguntar, faça recall. Uma referência curta do dono ("aprovou lá",
"aquele bug", "o de ontem") é resolvida contra a memória: aja na leitura
compatível com o estado registrado e declare a suposição em uma linha. Só abra
um menu quando duas leituras compatíveis levam a trabalho diferente; opção que
contradiz a memória não entra no menu. Quando o SessionStart avisar correções
pendentes, rode `demerzel memory review` no começo da sessão.
<!-- demerzel:end -->
