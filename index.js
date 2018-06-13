const r2 = require('r2')
const debug = require('debug')('resumable-http-download')
const parseContentRangeHeader = require('@ironsource/parse-content-range-header')

const INITIAL_STEP_SIZE = 1000 // 1k
const STEP_SIZE = 500000 // 100k
const START_POSITION = 0

/**
 *    @param  {[type]}
 *    @return {[type]}
 */
async function download({ url, headers = new Map(), store = new MemoryStore() }) {
	let state = await store.get('state')
	state = state || 'start'

	debug(`starting download from state "${state}"`)
	
	let action = getAction(state)

	let nextState
	try {
		nextState = await action({ url, headers: new Map(headers), store })
	} catch (e) {
		debug('error:', e)
		nextState = 'error'
	}

	debug(`nextState is "${nextState}"`)

	if (nextState !== 'end') {
		await store.set('state', nextState)
		return download({ url, headers, store })
	}

	// this is the payload
	return await downloadEnd({ store })
}

function getAction(state) {
	debug(`getting action for state "${state}"`)

	if (state === 'start') {
		return downloadStart
	}

	if (state === 'progress') {
		return downloadProgress
	}

	if (state === 'end') {
		return downloadEnd
	}

	if (state === 'error') {
		return downloadError
	}

	throw new Error(`invalid state ${state}`)
}

async function downloadStart({ url, headers, store }) {
	debug(`downloadStart( ${url} )`)
	await store.clear()

	let state = executeRequest({ url, headers, store, rangeStart: 0, rangeEnd: INITIAL_STEP_SIZE })

	if (state) {
		return state
	}

	return 'end'
}

async function downloadProgress({ url, headers, store }) {
	debug(`downloadProgress( ${url} )`)
	let range = await store.get('range')

	if (!range) {
		debug('failed to get "range" during progress state')
		return 'error'
	}

	return executeRequest({ url, headers, store, rangeStart: range.end, rangeEnd: range.end + STEP_SIZE })
}

async function downloadEnd({ store }) {
	return await store.payload()
}

// TODO change to exponential backoff
async function downloadError() {
	return new Promise((resolve, reject) => {
		setTimeout(() => resolve('progress'), 1000)
	})
}

async function executeRequest({ rangeStart, rangeEnd, url, store, headers }) {

	headers.Range = createRangeHeader(rangeStart, rangeEnd)
	debug(`downloading "Range: ${headers.Range}"`)

	let request = await r2.get(url, { headers })

	let response = await request.response

	let storeEtag = await store.get('etag')

	let {
		nextState,
		contentRange,
		currentEtag,
		contentLength
	} = processResponse(response, storeEtag)

	await store.set('etag', currentEtag)

	if (contentRange) {
		await store.set('size', contentRange.size)
		await store.set('range', contentRange.range)
	}

	let arrayBuffer = await response.arrayBuffer()
	await store.append(Buffer.from(arrayBuffer))

	return nextState
}

function processResponse(response, storeEtag) {

	if (!response.headers) {
		debug('cannot handle response without headers')
		return { nextState: 'end' }
	}

	let contentRange = getContentRange(response.headers)
	let contentLength = response.headers.get('content-length')

	debug(`content-length: "${contentLength}"`)

	if (contentLength === contentRange.size) {
		debug(`content length "${contentLength}" === size "${contentRange.size}"`)
		return { nextState: 'end' }
	}

	let currentEtag = response.headers.get('etag')

	if (!currentEtag) {
		throw new Error('missing etag')
	}

	if (storeEtag && storeEtag !== currentEtag) {
		debug('etag changed, restarting')
		return { nextState: 'start' }
	}

	let nextState
	if (contentRange.size === contentRange.range.end) {
		debug('finished')
		nextState = 'end'
	} else {
		nextState = 'progress'
	}

	return {
		nextState,
		currentEtag,
		contentRange,
		contentLength
	}
}

function getContentRange(headers) {
	let rawContentRange = headers.get('content-range')

	if (!rawContentRange) {
		return { size: headers.get('content-length') }
	}

	debug('content-range:', rawContentRange)

	let contentRange = parseContentRangeHeader(rawContentRange)

	if (!contentRange.isRangeSatisfied) {
		throw new Error('range not satisfied')
	}

	if (!contentRange.isSizeKnown) {
		throw new Error('size is unknown')
	}

	return contentRange
}

function getEtag(headers) {
	return response.headers.get('etag')
}

function isDifferentFile(currentEtag, storeEtag) {
	if (storeEtag && storeEtag !== currentEtag) {
		debug('file changed, need to restart')
		return true
	}

	return false
}

function createRangeHeader(start, end) {
	return `bytes=${start}-${end}`
}

class MemoryStore {
	constructor() {
		this.clear()
	}

	clear() {
		this.chunks = []
		this.data = {}
	}

	get(key, value) {
		return this.data[key]
	}

	set(key, value) {
		this.data[key] = value
	}

	append(chunk) {
		this.chunks.push(chunk)
	}

	payload() {
		return Buffer.concat(this.chunks)
	}
}

module.exports = {
	download,
	MemoryStore
}