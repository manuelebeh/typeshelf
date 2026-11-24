# Security policy

Typeshelf installs fonts, downloads files and answers requests from other applications through a local API, so a flaw in it can reach more than the app itself. Reports are welcome and taken seriously.

## Supported versions

Typeshelf has no release yet. Fixes go to the `main` branch, and once releases exist, only the latest one gets fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use [GitHub's private report form](https://github.com/manuelebeh/typeshelf/security/advisories/new) (Security › Report a vulnerability). Only the maintainers see it.

Include:

- the Typeshelf version or commit and your operating system,
- what an attacker needs (a web page, a local app, a crafted font file or document, a malicious response from the network) and what they get,
- steps to reproduce, or a proof of concept that does not harm anything.

Typeshelf is maintained by one person, so there is no guaranteed timeline. The aim is to answer within a week and to have a fix or a plan within a month for a confirmed flaw. A reporter who wants credit is named in the release notes.

## What counts

Things we want to hear about:

- a web page, or another machine, that gets the local API to answer or to act,
- a request to the local API that activates, imports or downloads something it should refuse,
- a font file, a document or a Google Fonts response that makes Typeshelf write outside its data folder, crash in a way an attacker controls, or run code,
- a plugin that can be made to send document data anywhere other than Typeshelf on the same machine,
- something leaving the machine that the readme says does not.

Not security flaws: a font that is detected, named or activated wrongly, or a plugin that misses a font. Report those as ordinary issues.

## How Typeshelf limits the damage

The rules are in [CONTRIBUTING.md](CONTRIBUTING.md#safety-rules). In short: the local API listens on the loopback interface only, checks the `Host` header against DNS rebinding, refuses requests with a web `Origin`, needs a client header that browsers cannot send without a CORS check it always refuses, and caps request size. Downloads only come from Google Fonts over HTTPS, and files removed from the library go to the Trash.
