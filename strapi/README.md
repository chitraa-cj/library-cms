# Strapi content-type artifacts

These `schema.json` files define Strapi v5 content types that the CMS portal proxies to.
The Strapi app itself lives on the backend box (`STRAPI_URL`, currently
`http://13.53.121.15:1337`), so these files are **deploy artifacts**, not wired into
this repo's build. Drop them into the Strapi project and restart it.

## video-resource

Pins a YouTube video to one node of the grantha hierarchy. `target_type` is the scope:

| target_type | target_doc_id points at             | shows on            |
| ----------- | ----------------------------------- | ------------------- |
| `grantha`   | the grantha's `documentId`          | grantha landing     |
| `section`   | a section's `documentId`            | that adhyaya/khanda/kanda/pada header (see `target_section_type`) |
| `manthra`   | a manthra's `documentId`            | that single verse   |

`draftAndPublish` is **off** for this type on purpose: the rows are written only by
the portal (the grantha editor's *Videos* list), and a draft row would be invisible to
the default REST read the portal reconciles against — every save would then re-create
the same videos. With it off, a written row is immediately live.

### Grantha video list (portal)

The grantha editor edits a grantha's videos as an ordered list and saves the WHOLE list
through the portal proxy:

- `GET  /api/strapi/video-resources/for-grantha/:granthaDocId` → the grantha's rows,
  ascending by `sort_order`. Returns `available: false` (not an error) while this
  content type is missing from Strapi, so the editor can say so instead of failing.
- `PUT  /api/strapi/video-resources/for-grantha/:granthaDocId` with
  `{ videos: [{ documentId?, youtubeUrl, title?, startSeconds? }] }` → reconciles
  against the existing rows (update / create / delete) and rewrites `sort_order` to
  1..n in the order sent. Position in the list IS the display order on the site.

Pasted links are normalized by `shared/youtube-url.ts`: watch / share / shorts / embed /
live URLs and bare ids are all accepted, stored as `https://www.youtube.com/watch?v=<id>`,
with any `t=` / `start=` timestamp moved into `start_seconds`.

Reader render policy is **inherit-with-fallback, many-per-node**: a node shows all its
own videos; if it has none, it borrows the nearest ancestor's. Resolution logic lives in
`shared/video-resource-resolve.ts` and the portal endpoint `GET /api/strapi/video-resources/for-node`.

### Deploy

On the Strapi box:

```bash
# from the Strapi project root
mkdir -p src/api/video-resource/content-types/video-resource
cp schema.json src/api/video-resource/content-types/video-resource/schema.json
```

Also create the standard controller/route/service so the REST API is exposed
(Strapi generates these when a type is made in the admin; when adding by file, add the
factory stubs):

```js
// src/api/video-resource/controllers/video-resource.js
'use strict';
const { createCoreController } = require('@strapi/strapi').factories;
module.exports = createCoreController('api::video-resource.video-resource');
```

```js
// src/api/video-resource/routes/video-resource.js
'use strict';
const { createCoreRouter } = require('@strapi/strapi').factories;
module.exports = createCoreRouter('api::video-resource.video-resource');
```

```js
// src/api/video-resource/services/video-resource.js
'use strict';
const { createCoreService } = require('@strapi/strapi').factories;
module.exports = createCoreService('api::video-resource.video-resource');
```

Then restart Strapi (`pm2 restart <app>`) and, in **Settings → Roles → Authenticated**,
grant `find`, `findOne`, `create`, `update`, `delete` on Video Resource so the portal's
authenticated proxy can reach it.

> Note: `pluralName` is `video-resources`, so the REST path is `/api/video-resources`,
> which is exactly what the portal proxy (`server/strapi.ts` `contentTypes`) expects.
