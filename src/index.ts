export { PostalTransport, createPostalTransport } from './transport.js';
export { PostalTransportError, ErrorCodes } from './errors.js';
export type { TransportErrorCode, PostalTransportErrorDetails } from './errors.js';
export type {
	PostalSendMode,
	PostalTransportOptions,
	PostalMessageOptions,
	PostalMailOptions,
	PostalEnvelope,
	PostalSendResult,
	PostalRecipientMessage,
	PostalApiErrorData,
	PostalApiResponse,
	PostalSentMessageInfo,
	PostalMailMessageLike,
	PostalMimeNodeLike,
	PostalSendCallback,
	PostalVerifyCallback
} from './types.js';

export { PostalTransport as default } from './transport.js';
