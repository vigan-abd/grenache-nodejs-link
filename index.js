'use strict'

const _ = require('lodash')
const async = require('async')
const uuid = require('uuid')
const Events = require('events')
const LRU = require('lru')
const request = require('request')
const CbQ = require('cbq')
const ed = require('ed25519-supercop')
const bencode = require('bencode')

class Link extends Events {
  constructor (conf) {
    super()

    this.conf = {
      grape: '',
      monitorTimeout: 2000,
      requestTimeout: 2500,
      lruMaxSizeLookup: 2500,
      lruMaxAgeLookup: 10000
    }

    _.extend(this.conf, conf)
  }

  init () {
    this._inited = true
    this.cache = {}
    this.cbq0 = new CbQ()
    this._reqs = new Map()
  }

  post (url, data, opts, cb) {
    request.post(_.extend({
      url: url,
      json: true,
      body: data
    }, opts), (err, res, data) => {
      if (res && !/^2..$/.test(res.statusCode)) {
        const err = new Error(data)
        err.code = res.statusCode
        return cb(err)
      }

      cb(err, res, data)
    })
  }

  getRequestHash (type, payload) {
    return `${type}:${JSON.stringify(payload)}`
  }

  request (type, payload, _opts = {}, cb) {
    async.retry(_opts.retry || 1, next => {
      this._request(type, payload, _opts, next)
    }, cb)
  }

  _request (type, payload, _opts, cb) {
    const opts = _.defaults(_opts, {
      timeout: this.conf.requestTimeout
    })

    const cache = this.cache[type]

    if (cache) {
      const qhash = this.getRequestHash(type, payload)
      const cval = cache.get(qhash)

      if (cval) {
        cb(null, cval)
        return
      }
    }

    const req = this.newRequest(type, payload, opts, cb)
    this.addRequest(req)

    this.cbq0.push(req.qhash, (err, data) => {
      this.handleReply(req.rid, err, data)
    })

    const kcnt = this.cbq0.cnt(req.qhash)
    if (kcnt > 1) {
      return
    }

    this.post(
      `${this.conf.grape}/${type}`,
      { rid: req.rid, data: req.payload },
      {
        timeout: opts.timeout
      },
      (err, rep, msg) => {
        this.handleReply(req.rid, err, msg, true)
      }
    )
  }

  handleReply (rid, err, data, fromGrape = false) {
    const req = this._reqs.get(rid)
    if (!req) {
      return
    }

    if (fromGrape) {
      if (!err && data) {
        let cache = this.cache[req.type]
        if (cache) {
          cache.set(req.qhash, data)
        }
      }

      this.cbq0.trigger(req.qhash, err, data)
      return
    }

    this.delRequest(req)
    req.cb(err, data)
  }

  newRequest (type, payload, opts, cb) {
    const rid = uuid.v4()

    const req = {
      rid: rid,
      type: type,
      payload: payload,
      opts: opts,
      cb: _.isFunction(cb) ? cb : () => {},
      _ts: Date.now()
    }

    req.qhash = this.getRequestHash(type, payload)

    return req
  }

  addRequest (req) {
    this._reqs.set(req.rid, req)
  }

  delRequest (req) {
    this._reqs.delete(req.rid)
  }

  getRequest (rid) {
    return this._reqs.get(rid)
  }

  lookup (key, opts = {}, cb) {
    this.request('lookup', key, opts, (err, res) => {
      if (err) {
        cb(err)
        return
      }

      if (!_.isArray(res) || !res.length) {
        return cb(new Error('ERR_GRAPE_LOOKUP_EMPTY'))
      }

      cb(null, res)
    })
  }

  announce (key, port, opts = {}, cb) {
    if (!cb) cb = () => {}
    this.request('announce', [key, port], opts, cb)
  }

  put (opts, cb) {
    this.request('put', opts, {}, cb)
  }

  putMutable (data, opts, cb) {
    if (!data.seq) return cb(new Error('ERR_MISSING_SEQ'))

    const { publicKey, secretKey } = opts.keys
    if (!publicKey || !secretKey) return cb(new Error('ERR_MISSING_KEY'))

    data.k = publicKey.toString('hex')

    const toEncode = { seq: data.seq, v: data.v }

    if (data.salt) toEncode.salt = data.salt

    const encoded = bencode
      .encode(toEncode)
      .slice(1, -1)
      .toString()

    data.sig = ed
      .sign(encoded, publicKey, secretKey)
      .toString('hex')

    this.put(data, cb)
  }

  get (hash, cb) {
    this.request('get', hash, {}, cb)
  }

  monitor () {
    const now = Date.now()

    this._reqs.forEach(req => {
      if (now > req._ts + req.opts.timeout) {
        this.handleReply(req.rid, new Error('ERR_TIMEOUT'), null, true)
      }
    })

    return this
  }

  start () {
    if (!this._inited) {
      this.init()
    }

    this._monitorItv = setInterval(this.monitor.bind(this), this.conf.monitorTimeout)

    _.each(['lookup'], fld => {
      const cfld = _.upperFirst(fld)

      const opts = {
        max: this.conf[`lruMaxSize${cfld}`],
        maxAge: this.conf[`lruMaxAge${cfld}`]
      }

      this.cache[fld] = new LRU(opts)
    })

    return this
  }

  stop () {
    clearInterval(this._monitorItv)

    _.each(this.cache, c => {
      c.clear()
    })

    return this
  }
}

module.exports = Link
