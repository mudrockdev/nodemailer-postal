# nodemailer-postal

[Nodemailer](https://nodemailer.com) transport that delivers mail through the
[Postal](https://postalserver.io) HTTP API instead of SMTP. Useful where outbound
SMTP is blocked or you simply want Postal's API features.

- Works with **nodemailer 8, 9 and 10**
- Zero runtime dependencies, uses the built-in `fetch`
- Ships ESM and CommonJS builds with TypeScript types
- Two send modes: `raw` (full MIME message, default) and `message` (structured fields)

## Install

```sh
npm install nodemailer nodemailer-postal
# or
bun add nodemailer nodemailer-postal
```

Requires Node.js 18+ (for the global `fetch`). nodemailer 10 itself requires Node.js 20+.

## Usage

```ts
import nodemailer from 'nodemailer';
import { PostalTransport } from 'nodemailer-postal';

const transporter = nodemailer.createTransport(
	new PostalTransport({
		host: 'postal.example.com', // or a full URL such as http://localhost:5000
		apiKey: process.env.POSTAL_API_KEY!
	})
);

const info = await transporter.sendMail({
	from: 'Widgets Inc <hello@example.com>',
	to: 'someone@example.org',
	subject: 'Hello from Postal',
	text: 'Plain text body',
	html: '<p>HTML body</p>',
	attachments: [{ filename: 'invoice.pdf', path: './invoice.pdf' }]
});

console.log(info.messageId, info.accepted, info.postal.message_id);
```

CommonJS works too:

```js
const nodemailer = require('nodemailer');
const { PostalTransport } = require('nodemailer-postal');
```

## Options

```ts
new PostalTransport({
	host: 'postal.example.com',
	apiKey: '...',
	mode: 'raw', // 'raw' | 'message', default 'raw'
	tag: 'newsletter', // default tag, only used in 'message' mode
	bounce: false, // mark messages as bounces
	timeout: 30_000, // request timeout in ms, 0 disables
	fetch: customFetch, // custom fetch implementation (proxies, tests)
	headers: { 'x-trace-id': '...' } // extra HTTP headers for every API call
});
```

| Option    | Type                     | Default            | Description                                                                      |
| --------- | ------------------------ | ------------------ | -------------------------------------------------------------------------------- |
| `host`    | `string`                 | required           | Postal server. A bare hostname is treated as HTTPS; a full URL is used as given. |
| `apiKey`  | `string`                 | required           | Server API key, sent as `X-Server-API-Key`.                                      |
| `mode`    | `'raw' \| 'message'`     | `'raw'`            | See [Send modes](#send-modes).                                                   |
| `tag`     | `string`                 | –                  | Default Postal tag (`message` mode only).                                        |
| `bounce`  | `boolean`                | `false`            | Mark messages as bounces.                                                        |
| `timeout` | `number`                 | `30000`            | Request timeout in milliseconds. `0` disables the timeout.                       |
| `fetch`   | `typeof fetch`           | `globalThis.fetch` | Custom fetch implementation.                                                     |
| `headers` | `Record<string, string>` | –                  | Extra HTTP headers added to every request.                                       |

### Per message options

Pass a `postal` object with the send options to override the transport defaults
for one message:

```ts
await transporter.sendMail({
	from: 'hello@example.com',
	to: 'someone@example.org',
	subject: 'Welcome',
	text: '...',
	postal: { mode: 'message', tag: 'welcome', bounce: false }
});
```

nodemailer's `SendMailOptions` type does not know about `postal`, so with an
object literal you may hit an excess property error. Use the `PostalMailOptions`
helper type in that case:

```ts
import type { SendMailOptions } from 'nodemailer';
import type { PostalMailOptions } from 'nodemailer-postal';

const options: PostalMailOptions<SendMailOptions> = {
	to,
	subject,
	text,
	postal: { tag: 'welcome' }
};
```

## Send modes

### `raw` (default)

nodemailer builds the complete RFC 2822 message and the transport posts it to
`/api/v1/send/raw` with the SMTP envelope (`mail_from`, `rcpt_to`). Everything
nodemailer supports is preserved: alternatives, inline images (`cid`), calendar
events, custom headers, DKIM signatures, custom envelopes, `List-*` headers and
so on. This behaves exactly like the SMTP transport would, just over HTTPS.

### `message`

The message fields are posted to `/api/v1/send/message` and Postal builds the
MIME message itself. Postal then stores the subject, tag, plain and HTML bodies
separately, which is nicer in the Postal UI and lets you use tags. The mapping:

| nodemailer                                   | Postal                                          |
| -------------------------------------------- | ----------------------------------------------- |
| `from`, `sender`, `replyTo`                  | `from`, `sender`, `reply_to`                    |
| `to`, `cc`, `bcc`                            | `to`, `cc`, `bcc` (max 50 each)                 |
| `subject`                                    | `subject`                                       |
| `text`, `html`                               | `plain_body`, `html_body`                       |
| `attachments`                                | `attachments` (name, content type, base64 data) |
| `headers`, `list`, `references`, `inReplyTo` | `headers`                                       |
| `postal.tag` / `tag` option                  | `tag`                                           |

Limitations of `message` mode: inline (`cid`) images become plain attachments,
and `alternatives`, `amp`, `watchHtml`, `icalEvent`, custom `envelope` and
DKIM signing are not sent. `info.messageId` is Postal's generated id because
Postal writes the `Message-ID` header in this mode.

## Result

`sendMail()` resolves with:

```ts
interface PostalSentMessageInfo {
	envelope: { from: string | false; to: string[] };
	messageId: string; // '<...>' — nodemailer's id in raw mode, Postal's in message mode
	accepted: string[]; // recipients present in Postal's response
	rejected: string[]; // envelope recipients missing from the response
	pending: string[]; // always empty
	response: string; // Postal's message_id
	mode: 'raw' | 'message';
	postal: {
		message_id: string;
		messages: Record<string, { id: number; token: string }>;
	};
}
```

With nodemailer 10 the result type is inferred automatically. nodemailer 8 and 9
rely on `@types/nodemailer`, which types every custom transport's result as the
SMTP result, so cast when you need the Postal fields:

```ts
import type { PostalSentMessageInfo } from 'nodemailer-postal';

const info = (await transporter.sendMail(message)) as unknown as PostalSentMessageInfo;
```

## Errors

Failures reject with a `PostalTransportError`:

```ts
import { PostalTransportError, ErrorCodes } from 'nodemailer-postal';

try {
	await transporter.sendMail(message);
} catch (err) {
	if (err instanceof PostalTransportError) {
		console.error(err.code, err.message, err.status, err.response);
	}
}
```

`err.code` is either the code Postal returned (`UnauthenticatedFromAddress`,
`NoRecipients`, `InvalidServerAPIKey`, `AccessDenied`, ...) or one of the
transport's own codes:

| Code          | Meaning                                               |
| ------------- | ----------------------------------------------------- |
| `ECONFIG`     | Invalid transport options.                            |
| `EMESSAGE`    | nodemailer could not build the message.               |
| `EENVELOPE`   | No recipients, or no sender in `raw` mode.            |
| `ECONNECTION` | The HTTP request could not be made.                   |
| `ETIMEDOUT`   | The request hit the `timeout`.                        |
| `EHTTP`       | Non-2xx response without a Postal JSON body.          |
| `ERESPONSE`   | 2xx response that was not the expected JSON envelope. |
| `EPARAMETER`  | Postal answered `status: "parameter-error"`.          |
| `EPOSTAL`     | Postal answered `status: "error"` without a code.     |

## `verify()`

`transporter.verify()` checks the host and API key by requesting a message
that does not exist. A `MessageNotFound` answer means the key is valid; anything
else rejects with the Postal error.

## Development

```sh
bun install
bun run typecheck   # tsc, also checks compatibility against nodemailer 8/9/10 types
bun run test        # bun test, runs the suite against nodemailer 8, 9 and 10
bun run build       # tsdown → dist/ (ESM + CJS + .d.ts)
```

## License

MIT
