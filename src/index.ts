import EventEmitter from 'node:events';
import urlLib from 'node:url';
import crypto from 'node:crypto';
import stream, {PassThrough as PassThroughStream} from 'node:stream';
import {ClientRequest, RequestOptions, ServerResponse} from 'node:http';
import normalizeUrl from 'normalize-url';
import getStream from 'get-stream';
import CachePolicy from 'http-cache-semantics';
import Response from 'responselike';
import Keyv from 'keyv';
import mimicResponse from 'mimic-response';
import {Options as CacheSemanticsOptions} from 'http-cache-semantics';
import ResponseLike from 'responselike';
import CacheableRequest, {CacheableRequestFunction, RequestFn} from './types.js';

// eslint-disable-next-line @typescript-eslint/naming-convention
const CacheableRequests = (request: RequestFn, cacheAdapter?: CacheableRequest.StorageAdapter | string): CacheableRequestFunction => {
	let cache: CacheableRequest.StorageAdapter;
	if (cacheAdapter instanceof Keyv) {
		cache = cacheAdapter;
	} else {
		if(typeof cacheAdapter === 'string') {
			cache = new Keyv({
				uri: cacheAdapter,
				namespace: 'cacheable-request',
			});
		} else {
			cache = new Keyv({
				store: cacheAdapter,
				namespace: 'cacheable-request',
			});
		}
	}

	return createCacheableRequest(request, cache);
};

function createCacheableRequest(request: RequestFn, cache: any) {
	return (options: (CacheableRequest.Options & RequestOptions)  ,
		cb?: (response: ServerResponse | ResponseLike) => void): EventEmitter => {
		let url;
		if (typeof options === 'string') {
			url = normalizeUrlObject(urlLib.parse(options));
			options = {};
		} else if (options instanceof urlLib.URL) {
			url = normalizeUrlObject(urlLib.parse(options.toString()));
			options = {};
		} else {
			const [pathname, ...searchParts] = (options.path || '').split('?');
			const search = searchParts.length > 0
				? `?${searchParts.join('?')}`
				: '';
			url = options.url ? normalizeUrlObject(urlLib.parse(options.url)) : normalizeUrlObject({...options, pathname, search});
		}

		options = {
			headers: {},
			method: 'GET',
			cache: true,
			strictTtl: false,
			automaticFailover: false,
			...options,
			...urlObjectToRequestOptions(url),
		};
		options.headers = Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]));
		const ee = new EventEmitter();
		const normalizedUrlString = normalizeUrl(urlLib.format(url), {
			stripWWW: false, // eslint-disable-line @typescript-eslint/naming-convention
			removeTrailingSlash: false,
			stripAuthentication: false,
		});
		let key = `${options.method}:${normalizedUrlString}`;
		// POST, PATCH, and PUT requests may be cached, depending on the response
		// cache-control headers. As a result, the body of the request should be
		// added to the cache key in order to avoid collisions.
		if (options.body && options.method != undefined && ['POST', 'PATCH', 'PUT'].includes(options.method)) {
			if (options.body instanceof stream.Readable) {
				// Streamed bodies should completely skip the cache because they may
				// or may not be hashable and in either case the stream would need to
				// close before the cache key could be generated.
				options.cache = false;
			} else {
				key += `:${crypto.createHash('md5').update(options.body).digest('hex')}`;
			}
		}

		let revalidate: any = false;
		let madeRequest = false;
		const makeRequest = (options_: any) => {
			madeRequest = true;
			let requestErrored = false;
			let requestErrorCallback: (...args: any[]) => void = () => {
				if (!requestErrored) {
					requestErrored = true;
				}
			};

			const requestErrorPromise = new Promise<void>(resolve => {
				requestErrorCallback = () => {
					if (!requestErrored) {
						requestErrored = true;
						resolve();
					}
				};
			});
			const handler = (response: any) => {
				if (revalidate) {
					response.status = response.statusCode;
					const revalidatedPolicy = CachePolicy.fromObject(revalidate.cachePolicy).revalidatedPolicy(options_, response);
					if (!revalidatedPolicy.modified) {
						const headers = convertHeaders(revalidatedPolicy.policy.responseHeaders());
						response = new Response(revalidate.statusCode, headers, revalidate.body, revalidate.url);
						response.cachePolicy = revalidatedPolicy.policy;
						response.fromCache = true;
					}
				}

				if (!response.fromCache) {
					response.cachePolicy = new CachePolicy(options_, response, options_);
					response.fromCache = false;
				}

				let clonedResponse;
				if (options_.cache && response.cachePolicy.storable()) {
					clonedResponse = cloneResponse(response);
					(async () => {
						try {
							const bodyPromise = getStream.buffer(response);
							await Promise.race([
								requestErrorPromise,
								new Promise(resolve => response.once('end', resolve)), // eslint-disable-line no-promise-executor-return
							]);
							const body = await bodyPromise;
							const value = {
								cachePolicy: response.cachePolicy.toObject(),
								url: response.url,
								statusCode: response.fromCache ? revalidate.statusCode : response.statusCode,
								body,
							};
							let ttl = options_.strictTtl ? response.cachePolicy.timeToLive() : undefined;
							if (options_.maxTtl) {
								ttl = ttl ? Math.min(ttl, options_.maxTtl) : options_.maxTtl;
							}

							if (options.hooks) {
								/* eslint-disable no-await-in-loop */
								for (const key of Object.keys(options.hooks)) {
									value.body = await options.hooks[key](value.body);
								}
								/* eslint-enable no-await-in-loop */
							}

							await cache.set(key, value, ttl);
						} catch (error: unknown) {
							ee.emit('error', new CacheableRequests.CacheError(error));
						}
					})();
				} else if (options_.cache && revalidate) {
					(async () => {
						try {
							await cache.delete(key);
						} catch (error: unknown) {
							ee.emit('error', new CacheableRequests.CacheError(error));
						}
					})();
				}

				ee.emit('response', clonedResponse || response);
				if (typeof cb === 'function') {
					cb(clonedResponse || response);
				}
			};

			try {
				const request_ = request(options_, handler);
				request_.once('error', requestErrorCallback);
				request_.once('abort', requestErrorCallback);
				ee.emit('request', request_);
			} catch (error: unknown) {
				ee.emit('error', new CacheableRequests.RequestError(error));
			}
		};

		(async () => {
			const get = async (options_: any) => {
				await Promise.resolve();
				const cacheEntry = options_.cache ? await cache.get(key) : undefined;

				if (typeof cacheEntry === 'undefined' && !options_.forceRefresh) {
					makeRequest(options_);
					return;
				}

				const policy = CachePolicy.fromObject(cacheEntry.cachePolicy);
				if (policy.satisfiesWithoutRevalidation(options_) && !options_.forceRefresh) {
					const headers = convertHeaders(policy.responseHeaders());
					const response: any = new Response(cacheEntry.statusCode, headers, cacheEntry.body, cacheEntry.url);
					response.cachePolicy = policy;
					response.fromCache = true;
					ee.emit('response', response);
					if (typeof cb === 'function') {
						cb(response);
					}
				} else if (policy.satisfiesWithoutRevalidation(options_) && Date.now() >= policy.timeToLive() && options_.forceRefresh) {
					await cache.delete(key);
					options_.headers = policy.revalidationHeaders(options_);
					makeRequest(options_);
				} else {
					revalidate = cacheEntry;
					options_.headers = policy.revalidationHeaders(options_);
					makeRequest(options_);
				}
			};

			const errorHandler = (error: any) => ee.emit('error', new CacheableRequests.CacheError(error));
			cache.once('error', errorHandler);
			ee.on('response', () => cache.removeListener('error', errorHandler));
			try {
				await get(options);
			} catch (error: unknown) {
				if (options.automaticFailover && !madeRequest) {
					makeRequest(options);
				}

				ee.emit('error', new CacheableRequests.CacheError(error));
			}
		})();

		return ee;
	};
}

function cloneResponse(response: any) {
	const clone = new PassThroughStream({autoDestroy: false});
	mimicResponse(response, clone);

	return response.pipe(clone);
}

function urlObjectToRequestOptions(url: any) {
	interface Option {
		path: string;
		pathname?: string;
		search?: string;
	}
	const options: Option = {...url};
	options.path = `${url.pathname || '/'}${url.search || ''}`;
	delete options.pathname;
	delete options.search;
	return options;
}

function normalizeUrlObject(url: any) {
	// If url was parsed by url.parse or new URL:
	// - hostname will be set
	// - host will be hostname[:port]
	// - port will be set if it was explicit in the parsed string
	// Otherwise, url was from request options:
	// - hostname or host may be set
	// - host shall not have port encoded
	return {
		protocol: url.protocol,
		auth: url.auth,
		hostname: url.hostname || url.host || 'localhost',
		port: url.port,
		pathname: url.pathname,
		search: url.search,
	};
}

function convertHeaders(headers: any) {
	const result: any = {};
	for (const name of Object.keys(headers)) {
		result[name.toLowerCase()] = headers[name];
	}

	return result;
}

CacheableRequests.RequestError = class extends Error {
	constructor(error: any) {
		super(error.message);
		Object.assign(this, error);
	}
};
CacheableRequests.CacheError = class extends Error {
	constructor(error: any) {
		super(error.message);
		Object.assign(this, error);
	}
};

export default CacheableRequests;
