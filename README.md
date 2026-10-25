# @pipeworx/euipo

EU trademark search, registered Community design search, the harmonised
Nice goods-and-services classification, the Locarno product-indications
classification, and the applicant/representative register, all from the
European Union Intellectual Property Office (EUIPO).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1879+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `euipo_search_trademarks(...)` — search EU trademarks (EUTM) by verbal element, applicant, Nice class, or status.
- `euipo_trademark(...)` — retrieve a single EU trademark by application/registration number.
- `euipo_search_designs(...)` — search registered Community designs (RCD) by indication, owner, or Locarno class.
- `euipo_search_goods_services(...)` — explore/search the harmonised Nice goods-and-services classification (useful for trademark clearance and filing prep).
- `euipo_validate_goods_services(...)` — validate a list of goods-and-services terms against the harmonised database; flags invalid characters, duplicates, forbidden terms.
- `euipo_search_product_indications(...)` — search the harmonised Locarno product-indications classification used in design filings.
- `euipo_search_persons(...)` — search applicants or representatives on record for EUIPO trademark/design procedures. No street/city/postal address for individuals — only country-level location is kept; every row carries a source and a role label.

## Auth

BYO only. Register a free application at `dev.euipo.europa.eu` and pass
`_apiKey = "client_id:client_secret"`. Subscribe the app to the "Trademark
search", "Design Search", "Goods and Services", "Product Indications" and
"Persons" API products (one free app covers all five). There is no platform
key for this pack by design — Pipeworx does not hold or pay for an EUIPO
credential.

## Data sources

- EUIPO, EU trademark register (EUTM)
- EUIPO, Registered Community design register (RCD)
- EUIPO, harmonised Nice goods-and-services classification (used for trademark filings)
- EUIPO, harmonised Locarno product-indications classification (used for design filings)
- EUIPO, applicant and representative register

## Notes

- Built 2026-07-14 and committed **dormant** — never added to the gateway's
  pack manifest, workspace dependencies, or catalog, so it logged zero
  external calls regardless of credential state. Wired in as part of fleet
  #3309 (2026-10-18), which also corrected the OAuth token endpoint (see
  below) and added the four tools above.
- The token endpoint was wrong in the original build
  (`auth.euipo.europa.eu/oidc/accessToken`, a dead host that returns a flat
  HTTP 502 — never a 401/403, so no credential could ever have worked against
  it). The corrected endpoint, confirmed against five independent EUIPO
  developer-portal OpenAPI specs, returns a proper CAS 401 challenge for
  bad/placeholder credentials.
- The Trademark Search / Design Search tools use RSQL filter expressions
  (`verbalElement=="*nike*";niceClasses=in=(9,25)`); the newer three tools
  (Goods and Services, Product Indications, Persons) are plain query-param
  REST with no RSQL.
- Privacy: `euipo_search_persons` withholds street/city/postal-code address
  details for natural persons (individual applicants, employee/legal/EUIPO-professional
  representatives) and keeps only the country. Organisation-type rows
  (business applicants, legal-association representatives) keep their
  registered address, since that is public-register entity data rather than
  a personal address.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "euipo": {
      "url": "https://gateway.pipeworx.io/euipo/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/euipo/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1879+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

This pack takes your own API key (`_apiKey`) — we don't front one for it, so there's no curl here that would run without it. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/euipo_search_trademarks`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "euipo": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-euipo"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-euipo
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Euipo data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
