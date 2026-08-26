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
