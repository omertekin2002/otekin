# `npx otekin`

A tiny terminal profile CLI for my profile

## Run

```bash
npx otekin
```

## Options

Use these to configure behavior

- `--non-interactive`: prints the message + links (no prompt)
- `--no-open`: don’t open links in a browser (prints the URL instead)
- `--select <website|linkedin|cv|exit>`: skip the prompt and pick an option
- `--json`: output JSON
- `--help`, `--version`

## Examples

```bash
npx otekin --non-interactive
npx otekin --select website --no-open
npx otekin --select cv --no-open
```
