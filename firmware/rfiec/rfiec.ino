// RetroFixer RFIEC – the PC acts as a drive (and as a printer) for the Commodore 64, or controls real drives and printers
// ---------------------------------------------------------------------------
// Firmware for an Arduino Pro Micro (ATmega32U4, 5 V / 16 MHz) connected to the IEC serial bus
// with the same wiring as the XUM1541 "PROMICRO" (no extra components):
//
//   Pro Micro   signal    IEC DIN pin
//   16 (PB2)    DATA      5
//   14 (PB3)    CLK       4
//    8 (PB4)    ATN       3
//    9 (PB5)    SRQ       1
//   10 (PB6)    RESET     6   (read in device mode, pulled low by the reset command in bus controller mode)
//   GND         GND       2
//
// The Pro Micro plays the part of the DEVICE (drive or printer): bus timing is handled by
// David Hansel's IECDevice library (GPL-3, https://github.com/dhansel/IECDevice); the firmware
// forwards every bus event (LISTEN, TALK, data, UNLISTEN, UNTALK) to the browser over the USB
// serial port, and the browser answers with the disk data (the "DOS" lives in the web page).
//
// Since version 2.0 there is also BUS CONTROLLER (MASTER) MODE (command 'M' 1): the Pro Micro does what the XUM1541 does,
// i.e. it drives the bus in place of the C64 (LISTEN, TALK, data, UNLISTEN, UNTALK) to read from and write to real drives or
// print on a real printer. Timing follows the Commodore IEC serial bus; the code here is written from scratch.
//
// Companion web pages: https://retrofixer.it/xum1541/ (drive) and https://retrofixer.it/stampante-commodore/ (printer).
// Project repository: https://github.com/zeus074/RFIEC
//
// Protocol (binary, over USB serial; the configured baud rate does not matter):
//   PC → Pro Micro
//     'V'                              requests the version → reply 'H'
//     'C' slot dev flags               configures slot 0 (drive) or 1 (printer): device number and enable (bit 0)
//     'D' slot seq len flags data[len] data to send to the C64 (len ≤ 64); flags bit0 = end of file, bit1 = no data
//     'F' slot loader proto            starts a fast loader detected by the web page (loader 2 = Final Cartridge III;
//                                      proto 1 LOAD and 5 LOADIMG read channel 0, 2 SAVE writes to channel 1;
//                                      loader 1 = Epyx FastLoad, proto 3: the file name comes from the loader)
//     'M' mode                         0 = device (emulated drive/printer), 1 = bus controller (master) → reply 'm' mode
//   bus controller (master) mode only:
//     'A' len flags byte[len]          bytes under ATN (LISTEN/TALK/OPEN/CLOSE/UNLISTEN/UNTALK); flags bit0 = a TALK follows:
//                                      the PC becomes the listener → reply 'a' n err (bytes accepted, 0 = no device;
//                                      err: 0 ok, 1 nobody pulls DATA, 2 the listener never releases, 3 byte not acknowledged,
//                                      4 the device does not take CLK after the TALK)
//     'B' len flags byte[len]          data for the listener; flags bit0 = EOI on the last byte → reply 'b' n
//     'G' lo hi                        reads up to lo+hi*256 bytes from the talker → replies 'g' n flags byte[n] (n ≤ 60;
//                                      flags bit0 = EOI received, bit1 = last chunk); stops after 1 s without data
//     'X'                              bus RESET (RESET line held low for 100 ms) → reply 'x'
//     'S'                              line measurement → reply 's' a b c d (32U4 port B: a = idle,
//                                      b = idle with internal pull-ups, c = with ATN and CLK pulled, after 1 ms,
//                                      d = 100 ms after releasing everything; bit 2 DATA, 3 CLK, 4 ATN, 6 RESET, 1 = high)
//   Pro Micro → PC
//     'H' len text                     firmware version
//     'L' slot sec                     LISTEN with secondary address (0x6n data, 0xEn CLOSE, 0xFn OPEN)
//     'T' slot sec seq                 TALK (seq: TALK session number)
//     'U' slot                         UNLISTEN
//     'K' slot seq lo hi               UNTALK: how many bytes the C64 actually read in this session
//     'W' slot len eoi data[len]       bytes sent by the C64 (len ≤ 32)
//     'Q' slot seq                     more data needed for the TALK in progress
//     'R'                              the bus RESET line went low
//
// License: GPL-3.0 (same as IECDevice).

#include <Arduino.h>
#include <util/delay.h>
#include <IECDevice.h>
#include <IECBusHandler.h>

#define PIN_ATN    8
#define PIN_CLK   14
#define PIN_DATA  16
#define PIN_RESET 10
#define PIN_SRQ    9

#define FW_VERSION "RFIEC 2.6"

// Serial port opened by the PC. Do NOT use "(bool) Serial" on the 32U4: it contains a delay(10), and the library
// calls isActive() while the C64 sends the address under ATN (which must be acknowledged within 1 ms).
static bool hostUp = false;
static bool lineUp() { return Serial.dtr() || Serial.rts(); }

// ---------------- queue towards the PC ----------------
#define OQ_SIZE 256
static uint8_t  oq[OQ_SIZE];
static uint16_t oqHead = 0, oqTail = 0;
static uint16_t oqUsed() { return (uint16_t)(oqHead - oqTail); }
static uint16_t oqFree() { return OQ_SIZE - oqUsed(); }
static bool oqPut(const uint8_t *b, uint8_t n)
{
  if( oqFree() < n ) return false;
  for(uint8_t i=0; i<n; i++) oq[(oqHead++) % OQ_SIZE] = b[i];
  return true;
}
static void oqPump()
{
  uint16_t n = oqUsed();
  if( n==0 || !hostUp ) return;
  int room = Serial.availableForWrite();
  if( room <= 0 ) return;
  uint8_t chunk[32];
  uint8_t k = 0;
  while( k < sizeof(chunk) && k < (uint16_t) room && k < n ) chunk[k++] = oq[(oqTail++) % OQ_SIZE];
  Serial.write(chunk, k);
}

// ---------------- bus controller (master) mode (like the XUM1541) ----------------
// Open-collector lines on port B: "pulled" = output driven low, "released" = input without pull-up (the pull-up
// resistors are in the drive and the printer). Short waits run with interrupts disabled and are counted in microseconds.
#define LN_DATA _BV(2)   // PB2 = pin 16
#define LN_CLK  _BV(3)   // PB3 = pin 14
#define LN_ATN  _BV(4)   // PB4 = pin 8
#define LN_RST  _BV(6)   // PB6 = pin 10
static bool master = false;
static inline void lnLow(uint8_t m)  { PORTB &= ~m; DDRB |= m; }
static inline void lnFree(uint8_t m) { DDRB &= ~m; PORTB &= ~m; }
static inline bool lnIsLow(uint8_t m) { return (PINB & m) == 0; }
static void lnFreeAll() { lnFree(LN_DATA | LN_CLK | LN_ATN | LN_RST); }
// short wait (interrupts disabled): true if the line reaches the wanted state within us microseconds
// (delayMicroseconds(1) at 16 MHz waits almost nothing: _delay_us is used instead, an exact busy-wait loop)
static bool waitShort(uint8_t m, bool low, uint16_t us)
{
  for( uint16_t n = 0; n < us; n++ ) { if( lnIsLow(m) == low ) return true; _delay_us(1); }
  return lnIsLow(m) == low;
}
static uint8_t mErr = 0;
// long wait (interrupts enabled), in milliseconds; aborts if the web page closes the serial port
static bool waitLong(uint8_t m, bool low, uint16_t ms)
{
  unsigned long t0 = millis();
  uint8_t k = 0;
  while( lnIsLow(m) != low )
    {
      if( millis() - t0 > ms ) return false;
      if( ++k==0 && !(Serial.dtr() || Serial.rts()) ) return false;
    }
  return true;
}
// send one byte as "talker": 0 = received, 1 = the listener is not ready, 2 = no acknowledge
static uint8_t mSendByte(uint8_t b, bool eoi, uint16_t readyMs)
{
  lnFree(LN_CLK);                                   // ready to send
  if( !waitLong(LN_DATA, false, readyMs) ) { mErr = 2; return 1; }  // the listener releases DATA when it is ready
  noInterrupts();
  if( eoi )
    {
      // EOI: wait without pulling CLK; the listener acknowledges by pulling DATA for at least 60 us
      if( !waitShort(LN_DATA, true, 2000) || !waitShort(LN_DATA, false, 2000) ) { interrupts(); return 2; }
    }
  lnLow(LN_CLK);
  // timing as in OpenCBM's XUM1541: CLK stays low for 75 us before each bit (the 1541 cannot cope with the 20 us
  // minimum from the specification), the bit is set 2 us before releasing CLK and stays valid for 20 us
  for( uint8_t i = 0; i < 8; i++ )
    {
      delayMicroseconds(75);
      if( !(b & 1) ) { lnLow(LN_DATA); _delay_us(2); }
      lnFree(LN_CLK);                                 // bit valid
      delayMicroseconds(20);
      lnLow(LN_CLK);
      lnFree(LN_DATA);
      b >>= 1;
    }
  bool ack = waitShort(LN_DATA, true, 2000);        // byte acknowledge (1 ms per the specification, twice that is tolerated)
  interrupts();
  delayMicroseconds(100);
  if( !ack ) mErr = 3;
  return ack ? 0 : 2;
}
// bytes under ATN; talk: after the last one the PC becomes the listener (the device takes CLK)
static uint8_t mAtn(const uint8_t *b, uint8_t n, bool talk)
{
  lnFree(LN_DATA); lnLow(LN_CLK); lnLow(LN_ATN);
  mErr = 0;
  // devices respond by pulling DATA within 1 ms (we wait up to 2 ms, like the XUM1541)
  if( !waitShort(LN_DATA, true, 2000) ) { lnFree(LN_ATN); lnFree(LN_CLK); mErr = 1; return 0; }   // no device
  delayMicroseconds(40);
  uint8_t sent = 0;
  // a busy drive (for example while reading the directory after an OPEN) only responds to ATN once it is done:
  // like the XUM1541 we wait for it to be ready (here up to 30 s)
  while( sent < n && mSendByte(b[sent], false, 30000)==0 ) sent++;
  if( sent < n ) { delayMicroseconds(20); lnFreeAll(); return sent; }   // byte not accepted: release the bus
  if( talk && sent==n )
    {
      // role reversal: the PC pulls DATA and releases ATN and CLK, then the drive takes CLK once it has finished
      // handling ATN. The 1541 takes a few milliseconds (the C64 Kernal waits forever): up to 100 ms here.
      lnLow(LN_DATA); delayMicroseconds(20); lnFree(LN_ATN); lnFree(LN_CLK);
      if( !waitLong(LN_CLK, true, 100) ) { lnFreeAll(); mErr = 4; return 0; }
    }
  else
    {
      delayMicroseconds(20);
      lnFree(LN_ATN);
      // after UNLISTEN or UNTALK the bus becomes free again; after LISTEN the PC stays talker (holds CLK)
      if( sent==0 || b[sent-1]==0x3F || b[sent-1]==0x5F ) { delayMicroseconds(100); lnFree(LN_CLK); lnFree(LN_DATA); }
    }
  return sent;
}
// receive one byte as "listener": -1 = the talker is not ready (after readyMs), -2 = error, otherwise byte | 0x100 if EOI
static int16_t mRecvByte(uint16_t readyMs)
{
  if( !waitLong(LN_CLK, false, readyMs) ) return -1; // the talker releases CLK when it is ready
  bool eoi = false;
  noInterrupts();
  lnFree(LN_DATA);                                  // ready to receive
  if( !waitShort(LN_CLK, true, 400) )
    {
      // no bit within 200 us: this is the last byte (EOI), we acknowledge it by pulling DATA for 70 us
      eoi = true;
      lnLow(LN_DATA); delayMicroseconds(70); lnFree(LN_DATA);
      if( !waitShort(LN_CLK, true, 2000) ) { interrupts(); return -2; }
    }
  uint8_t b = 0;
  for( uint8_t i = 0; i < 8; i++ )
    {
      if( !waitShort(LN_CLK, false, 1000) ) { interrupts(); return -2; }
      if( !lnIsLow(LN_DATA) ) b |= (1 << i);
      if( !waitShort(LN_CLK, true, 1000) ) { interrupts(); return -2; }
    }
  lnLow(LN_DATA);                                   // byte received
  interrupts();
  delayMicroseconds(50);
  return (int16_t) b | (eoi ? 0x100 : 0);
}
static void oqWait(uint8_t need) { while( oqFree() < need && hostUp ) { oqPump(); hostUp = Serial.dtr() || Serial.rts(); } }
static void mRead(uint16_t len)
{
  uint8_t buf[60], k = 0, flags = 0;
  for( uint16_t got = 0; got < len; got++ )
    {
      int16_t r = mRecvByte(1000);
      if( r < 0 ) break;
      buf[k++] = r & 0xFF;
      if( r & 0x100 ) { flags = 1; break; }
      if( k==sizeof(buf) ) { uint8_t h[3] = {'g', k, 0}; oqWait(3 + k); oqPut(h, 3); oqPut(buf, k); oqPump(); k = 0; }
    }
  uint8_t h[3] = {'g', k, (uint8_t) (flags | 2)};
  oqWait(3 + k); oqPut(h, 3); oqPut(buf, k);
}
static void mWrite(const uint8_t *b, uint8_t n, bool eoiLast)
{
  uint8_t sent = 0;
  while( sent < n && mSendByte(b[sent], eoiLast && sent==n-1, 30000)==0 ) sent++;
  uint8_t r[2] = {'b', sent};
  oqWait(2); oqPut(r, 2);
}
static void setMaster(bool on)
{
  lnFreeAll();
  master = on;
  uint8_t r[2] = {'m', (uint8_t) on};
  oqPut(r, 2);
}

static void pumpInput();
static void serviceHost() { pumpInput(); oqPump(); }

// ---------------- device on the bus ----------------
#define RB_SIZE 160
class RFDevice : public IECDevice
{
 public:
  RFDevice(uint8_t slot, uint8_t devnr) : IECDevice(devnr), m_slot(slot), m_enabled(false) {}

  uint8_t  m_slot;
  bool     m_enabled;
  // data to send to the C64 (TALK)
  uint8_t  rb[RB_SIZE];
  uint8_t  rbHead = 0, rbCount = 0;
  bool     talking = false, more = false, pending = false, noData = false;
  uint8_t  seq = 0, talkSec = 0;
  uint16_t consumed = 0;
  // data received from the C64 (LISTEN), forwarded to the PC in 32-byte chunks
  uint8_t  wb[32];
  uint8_t  wlen = 0;

  virtual bool isActive() { return m_enabled && hostUp; }

  void flushWrite(bool eoi)
  {
    if( wlen==0 && !eoi ) return;
    uint8_t h[4] = {'W', m_slot, wlen, (uint8_t) (eoi ? 1 : 0)};
    oqPut(h, 4);
    oqPut(wb, wlen);
    wlen = 0;
  }

  void dataFromHost(uint8_t s, const uint8_t *d, uint8_t n, uint8_t flags)
  {
    if( !talking || s!=seq ) return;          // reply for a session that is already closed
    pending = false;
    for(uint8_t i=0; i<n && rbCount<RB_SIZE; i++) rb[(rbHead + rbCount++) % RB_SIZE] = d[i];
    if( flags & 1 ) more = false;
    if( flags & 2 ) { more = false; noData = (rbCount==0); }
  }

  void prefetch()
  {
    if( talking && more && !pending && rbCount < RB_SIZE - 64 )
      {
        uint8_t q[3] = {'Q', m_slot, seq};
        if( oqPut(q, 3) ) pending = true;
      }
  }

 protected:
  virtual void reset()
  {
    talking = false; rbCount = 0; wlen = 0;
    if( m_slot==0 ) { uint8_t r = 'R'; oqPut(&r, 1); }
  }

 public:
  // fast loader requested by the web page (Final Cartridge III)
  void startFast(uint8_t loader, uint8_t proto)
  {
#ifdef IEC_FP_EPYX
    // Epyx: the library receives the file name, opens it on channel 0 (listen/write/unlisten) and then requests the data
    if( loader==IEC_FP_EPYX && proto==IEC_FL_PROT_HEADER ) { fastLoadRequest(loader, proto); return; }
#endif
#ifdef IEC_FP_FC3
    if( loader!=IEC_FP_FC3 ) return;
    if( proto==IEC_FL_PROT_LOAD || proto==IEC_FL_PROT_LOADIMG )
      talk(0x60);                             // data comes from channel 0, like a normal TALK
    else if( proto==IEC_FL_PROT_SAVE )
      listen(0x61);                           // data goes to channel 1 (the file opened by SAVE)
    else
      return;
    fastLoadRequest(loader, proto);
#endif
  }

  // block transfers (JiffyDOS, Final Cartridge III): here we can wait for the PC as long as needed
  virtual uint8_t read(uint8_t *buffer, uint8_t n)
  {
    uint8_t got = 0;
    unsigned long t0 = millis();
    while( got < n )
      {
        if( rbCount )
          {
            buffer[got++] = rb[rbHead];
            rbHead = (rbHead + 1) % RB_SIZE; rbCount--; consumed++;
            t0 = millis();
            continue;
          }
        if( !talking ) talk(0x60);           // first block of a fast loader: data from channel 0
        if( !more || !hostUp || millis()-t0 > 3000 ) break;
        prefetch();
        serviceHost();
      }
    return got;
  }

  virtual uint8_t write(uint8_t *buffer, uint8_t n, bool eoi)
  {
    unsigned long t0 = millis();
    for(uint8_t i=0; i<n; i++)
      {
        while( canWrite() < 0 )
          {
            if( !hostUp || millis()-t0 > 3000 ) return i;
            serviceHost();
          }
        write(buffer[i], eoi && i==n-1);
        t0 = millis();
      }
    return n;
  }

 protected:
  virtual void listen(uint8_t secondary)
  {
    if( talking ) untalk();                   // end of a fast TALK (the C64 does not send UNTALK)
    flushWrite(false);
    wlen = 0;
    uint8_t f[3] = {'L', m_slot, secondary};
    oqPut(f, 3);
  }

  virtual void unlisten()
  {
    flushWrite(false);
    uint8_t f[2] = {'U', m_slot};
    oqPut(f, 2);
  }

  virtual void talk(uint8_t secondary)
  {
    secondary = 0x60 | (secondary & 0x0F);
    // Epyx FastLoad calls talk(0) before every block: it is the same TALK continuing
    if( talking && secondary==talkSec ) return;
    talkSec = secondary;
    seq++;
    talking = true; more = true; pending = false; noData = false;
    rbHead = 0; rbCount = 0; consumed = 0;
    uint8_t f[4] = {'T', m_slot, secondary, seq};
    if( oqPut(f, 4) ) pending = true;         // the PC answers 'T' by sending the first data
  }

  virtual void untalk()
  {
    uint8_t f[5] = {'K', m_slot, seq, (uint8_t) (consumed & 0xFF), (uint8_t) (consumed >> 8)};
    oqPut(f, 5);
    talking = false; rbCount = 0; more = false; pending = false;
  }

  virtual int8_t canWrite()
  {
    return oqFree() >= 48 ? 1 : -1;
  }

  virtual void write(uint8_t data, bool eoi)
  {
    wb[wlen++] = data;
    if( eoi || wlen==sizeof(wb) ) flushWrite(eoi);
  }

  virtual int8_t canRead()
  {
    if( rbCount >= 2 ) return rbCount > 127 ? 127 : (int8_t) rbCount;
    if( rbCount==1 && !more ) return 1;       // last byte: the library sends it with EOI
    if( rbCount==0 && !more ) return 0;       // nothing to send (for example file not found)
    prefetch();
    return -1;                                // wait for data from the PC while keeping the bus busy
  }

  virtual uint8_t peek()
  {
    return rbCount ? rb[rbHead] : 0;
  }

  virtual uint8_t read()
  {
    if( rbCount==0 ) return 0;
    uint8_t d = rb[rbHead];
    rbHead = (rbHead + 1) % RB_SIZE; rbCount--; consumed++;
    return d;
  }
};

static RFDevice drive(0, 8), printer(1, 4);
static RFDevice *devs[2] = {&drive, &printer};
static IECBusHandler bus(PIN_ATN, PIN_CLK, PIN_DATA, PIN_RESET, 0xFF, PIN_SRQ);

// ---------------- commands from the PC ----------------
static uint8_t ib[72];
static uint8_t ibLen = 0;

static uint8_t frameLen(const uint8_t *b, uint8_t n)
{
  // returns the command length if it is complete, 0 if parts of it are still missing
  switch( b[0] )
    {
    case 'V': return 1;
    case 'C': return n >= 4 ? 4 : 0;
    case 'D': if( n < 5 ) return 0; return (n >= 5 + b[3]) ? 5 + b[3] : 0;
    case 'F': return n >= 4 ? 4 : 0;
    case 'M': return n >= 2 ? 2 : 0;
    case 'A': case 'B': if( n < 3 ) return 0; return (n >= 3 + b[1]) ? 3 + b[1] : 0;
    case 'G': return n >= 3 ? 3 : 0;
    case 'X': return 1;
    case 'S': return 1;
    default:  return 1;                       // unknown byte: discarded
    }
}

static void handleFrame(const uint8_t *b, uint8_t n)
{
  if( b[0]=='V' )
    {
      const char *v = FW_VERSION;
      uint8_t h[2] = {'H', (uint8_t) strlen(v)};
      oqPut(h, 2); oqPut((const uint8_t *) v, strlen(v));
    }
  else if( b[0]=='C' && b[1] < 2 )
    {
      devs[b[1]]->setDeviceNumber(b[2]);
      devs[b[1]]->m_enabled = (b[3] & 1)!=0;
    }
  else if( b[0]=='D' && b[1] < 2 && b[3] <= 64 )
    devs[b[1]]->dataFromHost(b[2], b + 5, b[3], b[4]);
  else if( b[0]=='F' && b[1]==0 )
    drive.startFast(b[2], b[3]);
  else if( b[0]=='M' )
    {
      // bus controller mode: the emulated devices go quiet and the library stops watching the bus
      drive.m_enabled = printer.m_enabled = false;
      setMaster(b[1]==1);
    }
  else if( master && b[0]=='A' && b[1] <= 64 )
    {
      uint8_t n = mAtn(b + 3, b[1], (b[2] & 1)!=0);
      uint8_t r[3] = {'a', n, mErr};
      oqWait(3); oqPut(r, 3);
    }
  else if( master && b[0]=='B' && b[1] <= 64 )
    mWrite(b + 3, b[1], (b[2] & 1)!=0);
  else if( master && b[0]=='G' )
    mRead(b[1] | (b[2] << 8));
  else if( master && b[0]=='S' )
    {
      uint8_t r[5] = {'s', 0, 0, 0, 0};
      lnFreeAll(); delayMicroseconds(200); r[1] = PINB;
      PORTB |= LN_DATA | LN_CLK | LN_ATN | LN_RST; delayMicroseconds(200); r[2] = PINB; lnFreeAll();
      lnLow(LN_ATN); lnLow(LN_CLK); delayMicroseconds(1000); r[3] = PINB;
      lnFreeAll(); delay(100); r[4] = PINB;
      oqWait(5); oqPut(r, 5);
    }
  else if( master && b[0]=='X' )
    {
      lnFreeAll(); lnLow(LN_RST); delay(100); lnFree(LN_RST);
      uint8_t r = 'x'; oqPut(&r, 1);
    }
}

static void pumpInput()
{
  // at most 64 bytes per pass, to get back to bus.task() quickly
  for(uint8_t k=0; k<64 && Serial.available(); k++)
    {
      if( ibLen < sizeof(ib) ) ib[ibLen++] = Serial.read(); else { ibLen = 0; continue; }
      uint8_t fl = frameLen(ib, ibLen);
      if( fl )
        {
          handleFrame(ib, fl);
          ibLen = 0;
        }
    }
}

void setup()
{
  Serial.begin(115200);
  bus.attachDevice(&drive);
  bus.attachDevice(&printer);
#ifdef IEC_FP_JIFFY
  drive.enableFastLoader(IEC_FP_JIFFY, true);
#endif
#ifdef IEC_FP_FC3
  drive.enableFastLoader(IEC_FP_FC3, true);
#endif
#ifdef IEC_FP_EPYX
  drive.enableFastLoader(IEC_FP_EPYX, true);
#endif
  bus.begin();
}

void loop()
{
  // in bus controller mode we drive the bus ourselves: the library must not respond to our own ATN
  if( !master ) bus.task();
  bool up = lineUp();
  if( up != hostUp )
    {
      // the PC opened or closed the port: start over from scratch, the devices are switched off until the PC configures them
      hostUp = up; oqHead = oqTail = 0; ibLen = 0;
      drive.m_enabled = printer.m_enabled = false;
      if( master ) { lnFreeAll(); master = false; }
    }
  if( !up ) return;
  pumpInput();
  drive.prefetch();
  oqPump();
}
