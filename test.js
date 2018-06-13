const { expect } = require('chai')
const http = require('http')
const { download, MemoryStore } = require('./index')

const FILE_SIZE = 100000
const PORT = 9090
const url1 = 'https://s3.amazonaws.com/lts-project/js/x'
const url2 = 'https://d1whtrv7j8kb0i.cloudfront.net/js/x'
const url3 = `http://localhost:${PORT}`


describe('resumable-http-download', () => {
	it('simply downloads a file in a single chunk', async() => {
		let server = await startTestServer(simpleProcessor)
		let result = await download({ url: url3 })

		validate(result.toString())
		server.close()
	})

	it('downloads a file in several chunks', async() => {
		let server = await startTestServer(chunkedProcessor)
		let result = await download({ url: url3 })

		validate(result.toString())
		server.close()
	})

	it('we restart if etag changed', async() => {
		let server = await startTestServer(changingEtagProcessor)
		let result = await download({ url: url3 })

		validate(result.toString())
		server.close()
	})

	it('server fail, persistent store between sessions', async() => {
		let store = new MemoryStore()
		let server = await startTestServer(failingProcessor)
		let result = await download({ url: url3, store })
		validate(result.toString())
		server.close()
	}).timeout(15000)
})

function validate(data) {
	data = data.split(',')
	expect(data).to.have.length(FILE_SIZE)
	for (let i = 0; i < FILE_SIZE; i++) {
		expect(data[i]).to.equal(i.toString())
	}
}

function createTestFile() {
	let x = ''

	for (let i = 0; i < FILE_SIZE; i++) {
		if (i > 0) x += ','
		x += i.toString()
	}

	return x
}

function chunkedProcessor(file) {
	return (req, res) => {
		let { start, end } = setupReply(res, req, file)
		res.setHeader('etag', 'foo')
		res.end(file.slice(start, end))
	}
}

function failingProcessor(file) {
	let count = 0

	return (req, res) => {

		let { start, end } = setupReply(res, req, file)

		res.setHeader('etag', 'foo')

		if (count++ < 2) {
			return res.end(file.slice(start, end))
		}

		req.connection.destroy()
		count = 0
	}
}

function changingEtagProcessor(file) {
	let tag = 0
	return (req, res) => {
		let { start, end } = setupReply(res, req, file)

		if (tag < 2) {
			tag++
		}

		res.setHeader('etag', tag.toString())

		res.end(file.slice(start, end))
	}
}

function simpleProcessor(file) {
	return (req, res) => res.end(file)
}

function setupReply(res, req, file) {
	let bytes = req.headers.range.split('=')
	bytes = bytes[1].split('-')
	bytes = bytes.map(e => parseInt(e))

	let [start, end] = bytes

	if (end >= file.length) {
		end = file.length
	}

	res.setHeader('content-length', file.length)
	res.setHeader('content-range', `bytes ${start}-${end}/${file.length}`)

	return { start, end }
}

async function startTestServer(processor) {
	let file = new Buffer(createTestFile())

	return new Promise((resolve, reject) => {
		let server = http.createServer(processor(file)).listen(PORT, err => {
			if (err) return reject(err)
			resolve(server)
		})
	})
}

async function wait(millis) {
	return new Promise((resolve, reject) => {
		setTimeout(resolve, millis)
	})
}