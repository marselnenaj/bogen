# Reference

| Page | What it lists |
| --- | --- |
| [Command line](cli.md) | Every `bogen` command, its options, and the environment variables. |
| [MCP tools](mcp-tools.md) | Every tool your agent can call, with its arguments, plus the resources, prompts, guides and the instructions a client receives. Generated from a running server. |
| [HTTP and WebSocket](http.md) | The server's routes and events, as the editor, the CLI and paired devices use them. |

## Keeping the MCP reference current

`mcp-tools.md` is written by a script that starts a server in the same process, on a free port and with
a temporary data folder that it removes afterwards, and asks it for `tools/list`,
`resources/templates/list`, `resources/list` and `prompts/list`. It never touches your own data folder
or a running Bogen. From the root of a checkout:

```sh
npx tsx scripts/gen-docs-reference.ts           # writes docs/guide/reference/mcp-tools.md
npx tsx scripts/gen-docs-reference.ts --check   # exits 1 when the page is out of date
```

The groups on that page are listed at the top of the script. A new tool that is in no group yet lands
under "Other tools", and the script names it on stderr.
