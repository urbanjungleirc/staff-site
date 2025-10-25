# Urban Jungle Staff Site

This repository hosts the Urban Jungle staff tools hub. The root `index.html` renders a simple directory of internal tools sourced from `tools.json`, and each tool can live in its own subdirectory (for example `hvt/`) or as a standalone page in the project root.

## Access Control

The site is intended for Urban Jungle team members only. Access is enforced through Cloudflare Zero Trust; make sure the final deployment domain is protected by the appropriate Zero Trust application policy before sharing the link.

## Managing Tools

- Update `tools.json` to add, edit, or remove entries. Each tool requires at least a `name` and `path`, and you can optionally include `description`, `category`, or `status`.
- Create a matching directory or file for every `path` you register. Static assets for a tool should live alongside its entry (e.g. `/hvt/index.html`).

## Local Preview

Any static file server (such as `python3 -m http.server` or `npx serve`) can be used to preview locally. Launch the server from the repository root so `index.html` and subdirectory assets are available at the expected paths.

## Deployment

Deploy the contents of this repository to your static hosting provider (e.g. GitHub Pages, Cloudflare Pages, or S3). Re-run your Cloudflare Zero Trust checks after deployment to confirm only authenticated staff can reach the hub.
