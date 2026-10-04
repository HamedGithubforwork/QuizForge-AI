# Web AdSense setup

Status: browser-only Phase 19 ad integration. The integration is disabled unless
valid public AdSense configuration is provided.

The provider-neutral presentation/call gate is now merged into the application branch; this adapter remains disabled until the external AdSense configuration and site requirements below are completed.

## Why manual ad units

QuizForge intentionally does not enable automatic ads. The product has
focus-critical study states where ads must never be requested, including active
quiz/review, answer reveal, and timed exam interactions.

Manual responsive display units let the product apply its own semantic surface
policy before any Google ad-provider request.

## Current placement

The first placement is the authenticated browser home/upload surface.

The ad is not requested when:

- the Electron desktop bridge is present;
- AdSense configuration is missing/invalid;
- the account entitlement cannot be verified;
- the account has lifetime Ad-Free;
- the semantic ad policy denies the surface.

No ad-provider request receives note/PDF text, generated questions, answers,
deck contents, Local AI prompts, auth tokens, or account identifiers from
QuizForge.

## Configuration

Frontend build-time variables:

- `VITE_ADSENSE_CLIENT` — AdSense publisher client such as
  `ca-pub-1234567890123456`;
- `VITE_ADSENSE_HOME_SLOT` — numeric responsive display ad-unit slot ID.

Both values are public browser configuration, not secrets.

When either value is missing or malformed, QuizForge renders no ad and does not
load the Google AdSense script.

## Provider behavior

The browser component:

1. confirms this is not the native desktop shell;
2. resolves the authenticated semantic account entitlement;
3. applies the provider-neutral ad-presentation policy;
4. only then injects the Google AdSense script and requests the manual responsive
   display unit;
5. absorbs provider failure so studying remains usable.

The desktop app never falls back to browser AdSense merely because it renders the
same hosted frontend.

## Google account/site steps still required

Before real ads can appear, the owner must complete the external AdSense steps:

1. create/use an AdSense account;
2. add and verify the production web site;
3. obtain the publisher/client ID;
4. create a responsive display ad unit and obtain its slot ID;
5. add Google's required `ads.txt` entry at the production site's root;
6. configure the two Vite variables for the web deployment;
7. verify policy/privacy/consent requirements for the intended audience and
   markets before enabling production traffic.

Do not put a publisher ID or ad slot into the desktop package as authorization
for native ads. This integration is browser-only.
