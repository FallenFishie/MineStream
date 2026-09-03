-- ============================================================
--  MineStream — CC:Tweaked client
--  Puts the GIF TV on your monitors and the radio on speakers.
--
--  Quick start (on the computer, next to a monitor + speaker):
--    wget run <server-url>/cc/minestream.lua
--
--  Optional settings:
--    set minestream.server "https://your-app.onrender.com"
--    set minestream.scale 0.5        -- smaller text = sharper picture
--    set minestream.overlay false    -- hide the music bar
--    set minestream.volume 2         -- speaker volume (0-3)
-- ============================================================

local SERVER = settings.get("minestream.server", "__SERVER_URL__")

if not SERVER or SERVER == "" or SERVER:find("__SERVER_URL__", 1, true) then
  term.clear()
  term.setCursorPos(1, 1)
  print("MineStream - CC:Tweaked client")
  write("Server URL (e.g. https://minestream.onrender.com): ")
  SERVER = read()
  settings.set("minestream.server", SERVER)
  settings.save(".minestream")
end

SERVER = (SERVER:gsub("/+$", ""))
local WS_URL = (SERVER:gsub("^http", "ws")) .. "/cc"

local SCALE = settings.get("minestream.scale")
local OVERLAY = settings.get("minestream.overlay", true)
local volume = settings.get("minestream.volume", 1)

-- ---------------------------------------------------------- peripherals

local function findMonitor()
  local best, bw, bh
  local list = { peripheral.find("monitor") }
  for _, m in ipairs(list) do
    local ok, w, h = pcall(m.getSize)
    if ok and (not best or w * h > bw * bh) then
      best, bw, bh = m, w, h
    end
  end
  return best, bw, bh
end

local function findSpeaker()
  local list = { peripheral.find("speaker") }
  return list[1]
end

local mon = findMonitor()
local speaker = findSpeaker()

if mon == nil and speaker == nil then
  printError("No monitor or speaker found! Attach at least one, then re-run.")
  return
end

if mon and SCALE then pcall(mon.setTextScale, mon, SCALE) end

local mw, mh = 0, 0
if mon then mw, mh = mon.getSize() end

-- pre-built blit rows
local rowSpaces = string.rep(" ", mw)
local rowFg = string.rep("0", mw)
local rowBlack = string.rep("f", mw)

local function rebuildRows()
  if mon then mw, mh = mon.getSize() end
  rowSpaces = string.rep(" ", mw)
  rowFg = string.rep("0", mw)
  rowBlack = string.rep("f", mw)
end

-- ---------------------------------------------------------- draw helpers

local function monClear()
  if not mon then return end
  for y = 1, mh do
    mon.setCursorPos(1, y)
    mon.blit(rowSpaces, rowFg, rowBlack)
  end
end

local function drawCenter(lines)
  if not mon then return end
  monClear()
  local y0 = math.max(1, math.floor(mh / 2) - math.floor(#lines / 2))
  for i, txt in ipairs(lines) do
    local x = math.max(1, math.floor((mw - #txt) / 2) + 1)
    local y = y0 + i - 1
    if y <= mh then
      mon.setCursorPos(x, y)
      mon.blit(txt, string.rep("0", #txt), string.rep("f", #txt))
    end
  end
end

local function say(msg)
  print("[MineStream] " .. msg)
end

-- ---------------------------------------------------------- state

local sp = { has = false }        -- spotify now playing
local radio = { playing = false } -- radio state
local tick = 0                    -- ticker offset
local pending = {}                -- queued audio chunks

-- ---------------------------------------------------------- base64 -> audio

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local b64lookup = {}
for i = 1, #B64 do b64lookup[string.byte(B64, i)] = i - 1 end

local function b64ToAudio(s)
  local t = {}
  if table.create then t = table.create(math.floor(#s * 0.75)) end
  local acc, bits, n = 0, 0, 0
  for i = 1, #s do
    local v = b64lookup[string.byte(s, i)]
    if v then
      acc = acc * 64 + v
      bits = bits + 6
      if bits >= 8 then
        local byte = math.floor(acc / 2 ^ (bits - 8)) % 256
        acc = acc % (2 ^ (bits - 8))
        bits = bits - 8
        n = n + 1
        if byte > 127 then byte = byte - 256 end
        t[n] = byte
      end
    end
  end
  return t
end

local function pumpAudio()
  if not speaker then return end
  while #pending > 0 do
    local chunk = table.remove(pending, 1)
    local ok, res = pcall(speaker.playAudio, chunk, volume)
    if not ok or res == false then
      -- queue full: put it back and wait for the speaker to drain
      table.insert(pending, 1, chunk)
      return
    end
  end
end

-- ---------------------------------------------------------- rendering

local function expandLine(spec)
  local parts = {}
  for c, n in string.gmatch(spec, "([0-9a-f])(%d+)") do
    parts[#parts + 1] = string.rep(c, tonumber(n))
  end
  local s = table.concat(parts)
  if #s < mw then
    s = s .. string.rep("f", mw - #s)
  elseif #s > mw then
    s = string.sub(s, 1, mw)
  end
  return s
end

local function fmtTime(ms)
  ms = math.max(0, math.floor(ms or 0))
  local s = math.floor(ms / 1000)
  return string.format("%d:%02d", math.floor(s / 60), s % 60)
end

local function overlayInfo()
  if radio.playing then
    local dur = radio.durationMs or 0
    local pos = os.epoch("utc") - (radio.startedAt or os.epoch("utc"))
    return "RADIO: " .. (radio.title or "?"),
      (dur > 0 and pos > 0) and math.min(1, pos / dur) or 0,
      (dur > 0) and (fmtTime(pos) .. "/" .. fmtTime(dur)) or "LIVE"
  elseif sp.has and sp.name then
    local pos = (sp.progressMs or 0)
    if sp.playing then pos = pos + (os.epoch("utc") - (sp.at or os.epoch("utc"))) end
    local dur = sp.durationMs or 0
    return (sp.name or "?") .. " - " .. (sp.artists or ""),
      dur > 0 and math.min(1, pos / dur) or 0,
      fmtTime(pos) .. "/" .. fmtTime(dur)
  end
  return nil
end

local function drawOverlay()
  if not mon or not OVERLAY or mh < 6 then return end

  local line, frac, times = overlayInfo()
  if not line then
    mon.setCursorPos(1, mh - 1)
    mon.blit(rowSpaces, rowFg, rowBlack)
    mon.setCursorPos(1, mh)
    mon.blit(rowSpaces, rowFg, rowBlack)
    return
  end

  frac = math.max(0, math.min(1, frac or 0))

  -- scrolling title row
  local text = line
  local vieww = mw - 1
  if #text > vieww then
    text = text .. "   "
    local off = (tick % #text) + 1
    text = string.sub(text .. text, off, off + vieww - 1)
  else
    text = string.sub(text .. string.rep(" ", vieww), 1, vieww)
  end
  mon.setCursorPos(1, mh - 1)
  mon.blit(text .. " ", string.rep("0", mw), string.rep("f", mw))

  -- progress row
  local barw = mw - #times - 1
  if barw < 4 then barw = 4 end
  local filled = math.floor(barw * frac + 0.5)
  local barBg = string.rep("d", math.min(barw, filled)) .. string.rep("7", math.max(0, barw - filled))
  local barTxt = string.rep(" ", barw)
  local tail = " " .. times
  mon.setCursorPos(1, mh)
  mon.blit(string.sub(barTxt .. tail, 1, mw), string.rep("0", mw), string.sub(barBg .. string.rep("f", #tail), 1, mw))
end

local function renderFrame(lines)
  if not mon then return end
  for y = 1, mh do
    local spec = lines[y]
    if spec then
      mon.setCursorPos(1, y)
      mon.blit(rowSpaces, rowFg, expandLine(spec))
    end
  end
  drawOverlay()
end

-- ---------------------------------------------------------- networking

local function tryConnect()
  local tries = 0
  while true do
    tries = tries + 1
    drawCenter({ "MINESTREAM", "connecting to:", string.sub(SERVER, 1, math.max(8, mw - 2)) })
    local ws, err = http.websocket(WS_URL)
    if ws then
      local hello = textutils.serialiseJSON({ t = "hello", w = mw, h = mh, audio = speaker ~= nil })
      ws.send(hello)
      say("connected (" .. tostring(tries == 1 and "first try" or tries .. " tries") .. ")")
      return ws
    end
    say("connect failed: " .. tostring(err) .. " — retrying in 3s")
    sleep(3)
  end
end

-- ---------------------------------------------------------- message routing

local function handleMessage(msg)
  local ok, data = pcall(textutils.unserialiseJSON, msg)
  if not ok or type(data) ~= "table" then return end
  local t = data.t

  if t == "f" then
    renderFrame(data.l)
  elseif t == "off" then
    drawCenter({ "MINESTREAM", "no GIF on air right now -", "paste a link on the website!" })
  elseif t == "bld" then
    drawCenter({ "DECODING GIF", "one moment..." })
  elseif t == "note" then
    drawCenter({ "VIDEOS DON'T WORK ON", "MONITORS — GIFS ONLY!" })
  elseif t == "gife" then
    drawCenter({ "GIF FAILED :(", string.sub(tostring(data.error), 1, math.max(8, mw - 2)) })
  elseif t == "welcome" then
    if data.spotify then sp = data.spotify end
    if data.radio then radio = data.radio end
  elseif t == "sp" then
    sp = data
  elseif t == "radio" then
    local wasPlaying = radio.playing
    radio = data
    if wasPlaying and not data.playing and speaker then
      speaker.playSound("block.note.pling", 1)
    end
  elseif t == "a" then
    if speaker and data.d then
      if #pending >= 14 then
        table.remove(pending, 1) -- falling behind, drop oldest
      end
      pending[#pending + 1] = b64ToAudio(data.d)
      pumpAudio()
    end
  end
end

-- ---------------------------------------------------------- main loop

local function eventLoop(ws)
  local ticker = os.startTimer(0.3)
  while true do
    local ev, a, b = os.pullEvent()
    if ev == "websocket_message" then
      -- CC:T passes the URL string as the first event param (some versions
      -- pass the handle) -- accept either so messages are never dropped.
      if a == WS_URL or a == ws then handleMessage(b) end
    elseif ev == "websocket_closed" then
      if a == WS_URL or a == ws then error("reconnect", 0) end
    elseif ev == "speaker_audio_empty" then
      pumpAudio()
    elseif ev == "timer" and a == ticker then
      tick = tick + 1
      drawOverlay()
      ticker = os.startTimer(0.3)
    elseif ev == "monitor_resize" then
      rebuildRows()
      if ws then pcall(ws.send, textutils.serialiseJSON({ t = "hello", w = mw, h = mh, audio = speaker ~= nil })) end
      ws.cc_resized = true
    elseif ev == "key" then
      if a == keys.Q then
        return
      elseif a == keys.MINUS or a == keys.EQUALS then
        volume = volume + (a == keys.EQUALS and 0.25 or -0.25)
        if volume > 3 then volume = 3 end
        if volume < 0 then volume = 0 end
        settings.set("minestream.volume", volume)
        settings.save(".minestream")
        say(string.format("volume %.2f", volume))
      end
    elseif ev == "terminate" then
      return
    end
  end
end

local function run()
  say("MineStream client starting")
  say("monitor: " .. (mon and (mw .. "x" .. mh) or "none") .. " | speaker: " .. (speaker and "yes" or "none"))
  if speaker and speaker.playAudio == nil then
    say("note: your CC:T is too old for speaker radio (needs playAudio, CC:T 1.100+). Monitor will still work!")
  end
  say("press Q to quit")
  while true do
    local ws = tryConnect()
    local ok, err = pcall(eventLoop, ws)
    pcall(ws.close, ws)
    if ok then break end
    if err == "reconnect" then
      drawCenter({ "CONNECTION LOST", "reconnecting..." })
      sleep(2)
    else
      error(err, 0)
    end
  end
  monClear()
  say("bye!")
end

local ok, err = pcall(run)
if not ok then
  printError("MineStream crashed: " .. tostring(err))
  printError("Report this to the TV station manager!")
end
