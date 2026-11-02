// Redis Lua scripts of spec 7.2. Each runs atomically; every key it touches carries the same `{tenant}` hash tag, so
// one script call is one Redis Cluster slot. Money is integer micro-USD written with HINCRBY (never HINCRBYFLOAT);
// numbers written to Redis or returned to Node are formatted with %d, because Lua's default formatting (and cjson's)
// switches to exponent notation above 14 digits.
//
// A reservation record (`ty:{t}:res:<id>`, a JSON string) lists its level keys with their estimates and its stream
// keys; settle and sweep read those keys from the record. They share the record's hash tag, so they sit in its slot.

/** Shared by settle and sweep: release one reservation, at `actual` on every level or at each level's estimate. */
const RELEASE = `
local function int(n) return string.format('%d', n) end
local function release(resKey, dlKey, actual)
  local raw = redis.call('GET', resKey)
  redis.call('ZREM', dlKey, resKey)
  if not raw then return 0 end
  local rec = cjson.decode(raw)
  for _, l in ipairs(rec.l) do
    local key, est = l[1], l[2]
    -- a key whose window expired long ago is not recreated
    if redis.call('EXISTS', key) == 1 then
      if est ~= '0' then redis.call('HINCRBY', key, 'r', '-' .. est) end
      local spent = actual or est
      if spent ~= '0' then redis.call('HINCRBY', key, 's', spent) end
    end
  end
  for _, key in ipairs(rec.s) do
    local n = tonumber(redis.call('GET', key) or '0')
    if n > 1 then redis.call('DECR', key) elseif n == 1 then redis.call('DEL', key) end
  end
  redis.call('DEL', resKey)
  return 1
end
`;

/**
 * KEYS: res, deadlines, budget keys..., gcra keys..., stream keys..., [taint key]
 * ARGV[1]: JSON { id, dl (deadline ms), sttl (stream key ttl ms), sx (session budget ttl ms),
 *   b: [{ n name, e est, l limit, f enforce, x expire-at ms or -1 for a session budget }],
 *   g: [{ n, e emission ms, b burst, q quantity }], s: [{ n, m max }], t?: { c: [hmac], a: [[hmac, rule]], ttl } }
 * Returns a JSON string: { r: 'ok' | 'dup' | 'taint' | 'rate' | 'streams' | 'budget', ... }.
 */
export const ADMIT_LUA = `
local function int(n) return string.format('%d', n) end
local p = cjson.decode(ARGV[1])
local t = redis.call('TIME')                                   -- the store clock, not the instance clock
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local resKey, dlKey = KEYS[1], KEYS[2]
local nb, ng, ns = #p.b, #p.g, #p.s
local bOff, gOff, sOff = 2, 2 + nb, 2 + nb + ng
if redis.call('EXISTS', resKey) == 1 then return cjson.encode({ r = 'dup' }) end

-- 0) taint: a last-turn block writes its HMACs (with the rule) and nothing else; else a history HMAC in the set blocks
if p.t then
  local tk = KEYS[3 + nb + ng + ns]
  if #p.t.a > 0 then
    for _, a in ipairs(p.t.a) do redis.call('HSET', tk, a[1], a[2]) end
    redis.call('PEXPIRE', tk, int(p.t.ttl))
    return cjson.encode({ r = 'taint', rule = p.t.a[1][2] })
  end
  for _, h in ipairs(p.t.c) do
    local rule = redis.call('HGET', tk, h)
    if rule then return cjson.encode({ r = 'taint', rule = rule, h = h }) end
  end
end

-- 1) GCRA, as src/limits/gcra.ts: the first failing limit refuses without writing anything
local tats = {}
for i, g in ipairs(p.g) do
  local tat = tonumber(redis.call('GET', KEYS[gOff + i]) or '0')
  if tat < now then tat = now end
  local nextTat = tat + g.e * g.q
  local allowAt = nextTat - g.e * g.b
  if allowAt > now then return cjson.encode({ r = 'rate', name = g.n, retry = int(allowAt - now) }) end
  tats[i] = nextTat
end

-- 2) stream slots
for i, s in ipairs(p.s) do
  if tonumber(redis.call('GET', KEYS[sOff + i]) or '0') >= s.m then return cjson.encode({ r = 'streams', name = s.n }) end
end

-- 3) budgets: enforced levels refuse when spent + reserved + est > limit; audit levels are reported, never block
local spent, reserved, audit, failing = {}, {}, {}, nil
for i, b in ipairs(p.b) do
  local v = redis.call('HMGET', KEYS[bOff + i], 's', 'r')
  spent[i], reserved[i] = tonumber(v[1] or '0'), tonumber(v[2] or '0')
  local over = spent[i] + reserved[i] + b.e > b.l
  if not b.f then table.insert(audit, { b.n, over })
  elseif over and not failing then failing = i end
end
local function totals()
  local out = {}
  for i, b in ipairs(p.b) do
    if b.f then table.insert(out, { KEYS[bOff + i], int(spent[i]), int(reserved[i]), int(b.l) }) end
  end
  return out
end
if failing then
  return cjson.encode({ r = 'budget', name = p.b[failing].n, spent = int(spent[failing]), audit = audit, totals = totals() })
end

-- 4) all passed: reserve on every level (audit ones too), take the slots, move the TATs, record the reservation
local levels, slots = {}, {}
for i, b in ipairs(p.b) do
  local key = KEYS[bOff + i]
  reserved[i] = redis.call('HINCRBY', key, 'r', int(b.e))
  if b.x < 0 then redis.call('PEXPIRE', key, int(p.sx)) else redis.call('PEXPIREAT', key, int(b.x)) end
  table.insert(levels, { key, int(b.e) })
end
for i, g in ipairs(p.g) do
  local ttl = tats[i] - now
  if ttl < 1 then ttl = 1 end
  redis.call('SET', KEYS[gOff + i], int(tats[i]), 'PX', int(ttl))
end
for i, s in ipairs(p.s) do
  redis.call('INCR', KEYS[sOff + i])
  redis.call('PEXPIRE', KEYS[sOff + i], int(p.sttl))
  table.insert(slots, KEYS[sOff + i])
end
redis.call('SET', resKey, cjson.encode({ l = levels, s = slots }))
redis.call('ZADD', dlKey, int(now + p.dl), resKey)
return cjson.encode({ r = 'ok', audit = audit, totals = totals() })
`;

/** KEYS: res, deadlines. ARGV[1]: actual micro-USD. Returns 1 settled, 0 unknown (already settled or swept). */
export const SETTLE_LUA = `${RELEASE}
return release(KEYS[1], KEYS[2], ARGV[1])
`;

/**
 * KEYS: deadlines. ARGV: batch size. Settles reservations past their deadline at their estimates; returns their res
 * keys. "Past" is judged on Redis TIME, the clock admit scored the deadlines with, so a fast instance clock cannot
 * sweep a live reservation and free its stream slot early.
 */
export const SWEEP_LUA = `${RELEASE}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', int(now), 'LIMIT', 0, tonumber(ARGV[1]))
local done = {}
for _, resKey in ipairs(due) do
  if release(resKey, KEYS[1], nil) == 1 then table.insert(done, resKey) end
end
return done
`;

/**
 * KEYS: budget key. ARGV: spent micro-USD, ttl ms. Warm-up: spent becomes max(current, seeded) and the TTL only
 * grows, so an instance seeding from its own (partial) traces never lowers what a shared store already counts.
 */
export const SEED_LUA = `
local cur = tonumber(redis.call('HGET', KEYS[1], 's') or '0')
if tonumber(ARGV[1]) > cur then redis.call('HSET', KEYS[1], 's', ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < tonumber(ARGV[2]) then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 1
`;
