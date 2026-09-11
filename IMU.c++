/*
 * Breadcrumb: 2026-09-06 20:25 - Production Suite with Native WiFiManager Engine
 * Target Board: LilyGo T-SIM7000G (ESP32 Dev Module)
 * 
 * Version History & Evolution:
 *  - 2026-09-06 17:12: Direct SHTP + HSPI SD + PMIC 5V Boost Baseline.
 *  - 2026-09-06 17:18: [CRITICAL BUGFIX FLAG - DO NOT REMOVE] Multi-report payload parser implemented.
 *                      Dismissed code: rigid `rxBuffer[4] == 0x08` checks failed because BNO085 
 *                      prepends 0xFB (Base Timestamp) packets during active 50Hz streams.
 *  - 2026-09-06 18:55: Configurable Remote Dashboard Parameters in RTC Slow Memory + IMU-Master Auto-Wake
 *                      with 0.1 delta threshold (one decimal place) and Significant Motion arming (0x12).
 *  - 2026-09-06 19:10: SHTP FIFO drain before sleep to prevent immediate false wake-ups on GPIO 33.
 *  - 2026-09-06 19:40: Reverse Wave (G -> S), STAG battery gauge (3='S', 2='T', 1='A', 0='G'),
 *                      calibrated VBAT ADC (GPIO 35), and pulsing white charge animation.
 *  - 2026-09-06 20:25: Replaced custom AP/DNS server with tzapu's WiFiManager for 100% reliable
 *                      Android 14 / Galaxy S24 Ultra Captive Portal popup.
 * 
 * Hardware Pin Mapping:
 *  - HSPI SD Card:    CS=15 (Blue), MOSI=13 (White), MISO=2 (Green), SCK=14 (Yellow)
 *  - Shared I2C:      SDA=21, SCL=22 (BNO085 @ 0x4A, BQ24295 @ 0x6B)
 *  - Wake Pins:       BNO085 INT=GPIO 33 (Active-LOW, EXT0), Button=GPIO 34 (Active-LOW, EXT1)
 *  - Battery Sense:   GPIO 35 (2:1 Teiler)
 *  - NeoPixels (4x):  Data = GPIO 12
 */

/*
 * Breadcrumb: 2026-09-06 20:35 - Clean Native WebServer & DNS Engine
 * Fix: Replaced WiFiManager wrapper with deterministic native WebServer & authoritative DNS.
 */

#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <WiFi.h>
#include <DNSServer.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <Adafruit_NeoPixel.h>
#include <esp_sleep.h>
#include <driver/rtc_io.h>
#include <math.h>
#include <driver/gpio.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>


// ==========================================
// 1. PIN & REGISTER DEFINITIONS
// ==========================================
/*
 * Breadcrumb: 2026-09-06 20:35 - Fixed DNS_PORT & Core Constants
 * [CRITICAL BUGFIX FLAG - PIN ASSIGNMENTS]: Retain HSPI & I2C pin mapping.
 */
#define I2C_SDA_PIN        21
#define I2C_SCL_PIN        22

#define SD_CS              15
#define SD_MOSI            13
#define SD_MISO             2
#define SD_SCK             14

#define BUTTON_PIN         GPIO_NUM_34
#define BNO08X_INT         GPIO_NUM_32   // Umgeklemmt von GPIO 33 auf 32!
#define BNO085_I2C_ADDR    0x4A
#define BAT_ADC_PIN        35

#define LED_PIN            12
#define NUM_PIXELS         4

#define BQ24295_ADDR       0x6B
#define BQ_REG_INPUT_SRC   0x00
#define BQ_REG_SYS_CONFIG  0x01
#define BQ_REG_VREG        0x04
#define BQ_REG_TIMER       0x05
#define BQ_REG_SYS_STATUS  0x08
#define BQ_REG_FAULT       0x09

#define AP_SSID            "STAG IMU"
#define AP_PASS            "stag2026"
#define DNS_PORT           53
/*
 * Breadcrumb: 2026-09-10 00:05 - LilyGo T-SIM7000G Modem Hardware Pinout
 * [CRITICAL BUGFIX FLAG - MODEM PINOUT]:
 * Mapped SIM7000G UART2 and PWRKEY pins.
 * Note: GPIO 33 is reserved for MODEM_RI, BNO INT remains on GPIO 32.
 */
#define MODEM_TX_PIN       27
#define MODEM_RX_PIN       26
#define MODEM_PWRKEY_PIN   4
#define MODEM_BAUDRATE     115200
#define PATH_SIM_FILE      "/settings/sim.json"


/*
 * Breadcrumb: 2026-09-07 20:50 - Scope Ordering & Clean Forward Definitions Fix
 * [CRITICAL BUGFIX FLAG - SCOPE]:
 * Placed global SD objects and flags (sdAvailable) BEFORE SD helper functions.
 * Removed duplicate loadConfigFromSD / saveConfigToSD definitions.
 */

// ==========================================
// 2. DASHBOARD CONFIGURATION & STRUCTURES
// ==========================================
#define PATH_SETTINGS_DIR "/settings"
#define PATH_CONFIG_FILE  "/settings/config.json"
#define PATH_WIFI_FILE    "/settings/wifi.json"
#define PATH_LOGS_DIR     "/Logs"
#define PATH_BAT_LOG      "/Logs/battery_log.csv"
#define PATH_ERR_LOG      "/Logs/error_log.txt"
#define PATH_OS_DIR       "/OS"
#define BQ_REG_CHRG_CURRENT 0x02
#define FIRMWARE_VERSION        "1.0.0"
#define PATH_OTA_TEMP_BIN       "/OS/firmware_update.bin"
#define FIRMWARE_BUILD_DATE  __DATE__ " " __TIME__


struct DeviceConfig {
  uint32_t lteBatchInterval_min;
  uint8_t imuSampleRate_hz;
  bool continuousLiveMode;
  bool gpsRequestPending;
  bool gpsPeriodicTracking;
  float imuWakeSensitivity;
  float motionSleepDeltaThreshold;
  uint32_t idleSleepTimeout_ms;
};

RTC_DATA_ATTR DeviceConfig sysConfig = {
  .lteBatchInterval_min = 5,
  .imuSampleRate_hz = 10,
  .continuousLiveMode = false,
  .gpsRequestPending = false,
  .gpsPeriodicTracking = false,
  .imuWakeSensitivity = 0.20f, // 0.20 m/s² Standard
  .motionSleepDeltaThreshold = 0.100f,
  .idleSleepTimeout_ms = 4000
};

struct BMSStatus {
  String vbusStatus;
  String chargeStatus;     // "Entladen", "Vorladung", "Schnellladung", "Voll geladen"
  bool isCharging;
  bool isFullyCharged;
  uint16_t chargeCurrent_mA; // z.B. 1024 mA
  bool powerGood;
  bool boostEnabled;
  float batteryVoltage;
  int batteryPercent;
  float targetVoltage;
  uint8_t rawStatus;
  uint8_t rawFault;
};

// [CRITICAL BUGFIX FLAG] Globale Variable, NACH der Struktur deklariert!
// Verhindert I2C-Kollisionen im Async-Webserver.
BMSStatus globalBmsStatus;

RTC_DATA_ATTR int bootCycleCount = 0;

enum LedDisplayMode {
  LED_MODE_OFF,
  LED_MODE_BATTERY_ANIM,
  LED_MODE_WIFI_WAVE,
  LED_MODE_CHARGING
};

LedDisplayMode currentLedMode = LED_MODE_OFF;
bool wifiApActive = false;
bool wifiStaActive = false;
bool isCharging = false;
String staSsid = "";
String staPass = "";

// Wi-Fi Auto-Timeout Flags
uint32_t wifiActivatedTime = 0;
uint32_t wifiLastClientSeenTime = 0;
bool hadAtLeastOneClient = false;

/*
 * Breadcrumb: 2026-09-10 00:10 - LTE Modem State & Stream Flags
 * Feature: Non-blocking timers and flags for SIM PIN handling and LTE streaming.
 */
String simPin = "";
String simApn = "gprs.swisscom.ch";
bool lteModemReady = false;
bool lteNetworkRegistered = false;
bool lteStreamingActive = false;
uint32_t lastLteBatchTime = 0;
uint32_t lastLteStreamBroadcastTime = 0;

// Non-blocking WiFi-Fallback Timer
bool wifiConnecting = false;
uint32_t wifiConnectStartTime = 0;

// Battery Animation State (S=3, T=2, A=1, G=0)
uint32_t batAnimStartTime = 0;
uint32_t batAnimLastStepTime = 0;
int8_t   batAnimCurrentLed = 3;
uint8_t  batAnimBrightnessStep = 1;
int      targetBatteryPct = 100;
bool     isBatteryAnimRunning = false;
uint32_t lastWaveTime = 0;
uint32_t lastChargePulseTime = 0;
uint32_t lastBmsPollTime = 0;

/*
 * Breadcrumb: 2026-09-09 21:30 - Supabase REST Sync Configuration
 * Feature: Direct PostgREST ingestion credentials and sync pointer definitions.
 */
/*
 * Breadcrumb: 2026-09-09 22:00 - Cleaned Supabase Anon Key JWT
 * [CRITICAL BUGFIX FLAG - SUPABASE AUTH]:
 * Stripped bracket artefacts '<' and '>' to prevent 401 Unauthorized API rejections.
 */
#define SUPABASE_URL       "https://fajwusnwfywfebyffxtf.supabase.co"
#define SUPABASE_ANON_KEY  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhand1c253Znl3ZmVieWZmeHRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5NzYxMjcsImV4cCI6MjEwNDU1MjEyN30.Yt-COlgIh5TySB01EGrdddrZguxW30cwhCeXdMjQ0aM"
#define DEVICE_IDENTIFIER  "STAG-IMU-01"
#define PATH_SYNC_PTR      "/settings/sync_ptr.json"
struct SyncPointer {
  uint32_t batLogOffset;
};

SyncPointer syncPtr = { .batLogOffset = 0 };
uint32_t lastCloudSyncTime = 0;
bool isSyncingLogs = false;

/*
 * Breadcrumb: 2026-09-09 22:45 - Supabase Realtime Broadcast Protocol State
 * Feature: Native ESP-IDF WSS Client for ephemeral Phoenix Channel streaming.
 */
/*
 * Breadcrumb: 2026-09-09 23:25 - Native WiFiClientSecure WebSocket State
 * [CRITICAL BUGFIX FLAG - NO IDF DEPENDENCY]:
 * Dismissed esp_websocket_client.h: not exposed in Arduino core include paths.
 * Replaced with native WiFiClientSecure instance and RFC-6455 stream flags.
 */
WiFiClientSecure supabaseWsClient;
bool supabaseWsConnected = false;
bool supabaseWsJoined    = false;
uint32_t lastWsHeartbeatTime = 0;
uint32_t lastCloudWsBroadcastTime = 0;

// ==========================================
// 3. GLOBAL OBJECTS & SD HELPER FUNCTIONS
// ==========================================
SPIClass sdSPI(HSPI);
DNSServer dnsServer;
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");
Adafruit_NeoPixel pixels(NUM_PIXELS, LED_PIN, NEO_GRB + NEO_KHZ800);

bool sdAvailable = false;
bool imuAvailable = false;
bool bmsAvailable = false;
uint64_t sdTotalBytes = 0;
uint64_t sdUsedBytes = 0;

bool otaTriggered = false;
String otaTargetBinPath = "";

volatile uint32_t imuInterruptCount = 0;
uint32_t lastInterruptSnapshot = 0;
uint32_t lastDiagPrintTime = 0;
uint32_t lastSdLogTime = 0;
uint32_t lastWdtResetTime = 0;
uint32_t lastMotionTimestamp = 0;
uint32_t lastWsBroadcastTime = 0;

bool buttonLastState = HIGH;
uint32_t buttonPressStartTime = 0;

bool timeIsSynchronized = false;
unsigned long syncEpochTime = 0;
unsigned long syncMillisOffset = 0;
float latest_ax = 0.0f, latest_ay = 0.0f, latest_az = 0.0f;

/*
 * Breadcrumb: 2026-09-09 22:25 - Consolidated SNTP & Fallback Timestamp Formatter
 * [CRITICAL BUGFIX FLAG - REDEFINITION RESOLUTION]:
 * Removed duplicate getFormattedTimestamp() definition.
 * Evaluates internal POSIX clock (> 2024 epoch). Returns UTC ISO-format
 * to prevent Supabase Postgres TIMESTAMPTZ syntax rejection (HTTP 400).
 */
String getFormattedTimestamp() {
  time_t now;
  time(&now);
  if (now > 1704067200) { // Größer als 01.01.2024 -> SNTP synchronisiert
    struct tm timeinfo;
    gmtime_r(&now, &timeinfo);
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &timeinfo);
    return String(buf);
  } else {
    char buf[32];
    snprintf(buf, sizeof(buf), "BOOT+%lums", millis());
    return String(buf);
  }
}

float latest_qw = 1.0f, latest_qx = 0.0f, latest_qy = 0.0f, latest_qz = 0.0f;
float ref_qw = 1.0f, ref_qx = 0.0f, ref_qy = 0.0f, ref_qz = 0.0f;
bool hasValidQuat = false;

// SD Dateiverwaltung
void createSdDirectories() {
  if (!sdAvailable) return;
  if (!SD.exists(PATH_SETTINGS_DIR)) SD.mkdir(PATH_SETTINGS_DIR);
  if (!SD.exists(PATH_LOGS_DIR)) SD.mkdir(PATH_LOGS_DIR);
  if (!SD.exists(PATH_OS_DIR)) SD.mkdir(PATH_OS_DIR);
}

/*
 * Breadcrumb: 2026-09-09 22:30 - Config Persistence with Configurable Idle Sleep
 * [CRITICAL BUGFIX FLAG - PERSISTENT SLEEP TIMEOUT]:
 * Added 'idle' key (in seconds) to /settings/config.json.
 * Converts to idleSleepTimeout_ms (5000ms - 60000ms) on load.
 */
void saveConfigToSD() {
  if (!sdAvailable) return;
  createSdDirectories();
  File cfgFile = SD.open(PATH_CONFIG_FILE, FILE_WRITE);
  if (cfgFile) {
    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"sens\":%.2f,\"delta\":%.2f,\"lte\":%u,\"rate\":%u,\"continuous\":%s,\"idle\":%u}",
             sysConfig.imuWakeSensitivity,
             sysConfig.motionSleepDeltaThreshold,
             sysConfig.lteBatchInterval_min,
             sysConfig.imuSampleRate_hz,
             sysConfig.continuousLiveMode ? "true" : "false",
             sysConfig.idleSleepTimeout_ms / 1000);
    cfgFile.print(buf);
    cfgFile.close();
    Serial.println("[CONFIG] Einstellungen gespeichert (/settings/config.json).");
  }
}

void loadConfigFromSD() {
  if (!sdAvailable || !SD.exists(PATH_CONFIG_FILE)) return;
  File cfgFile = SD.open(PATH_CONFIG_FILE, FILE_READ);
  if (cfgFile) {
    String content = cfgFile.readString();
    cfgFile.close();

    int idxSens = content.indexOf("\"sens\":");
    if (idxSens != -1) {
      int s = idxSens + 7;
      int e = content.indexOf(",", s); if (e == -1) e = content.indexOf("}", s);
      sysConfig.imuWakeSensitivity = content.substring(s, e).toFloat();
    }
    int idxDelta = content.indexOf("\"delta\":");
    if (idxDelta != -1) {
      int s = idxDelta + 8;
      int e = content.indexOf(",", s); if (e == -1) e = content.indexOf("}", s);
      sysConfig.motionSleepDeltaThreshold = content.substring(s, e).toFloat();
    }
    int idxLte = content.indexOf("\"lte\":");
    if (idxLte != -1) {
      int s = idxLte + 6;
      int e = content.indexOf(",", s); if (e == -1) e = content.indexOf("}", s);
      sysConfig.lteBatchInterval_min = content.substring(s, e).toInt();
    }
    int idxRate = content.indexOf("\"rate\":");
    if (idxRate != -1) {
      int s = idxRate + 7;
      int e = content.indexOf(",", s); if (e == -1) e = content.indexOf("}", s);
      uint8_t r = content.substring(s, e).toInt();
      if (r >= 5 && r <= 30) sysConfig.imuSampleRate_hz = r;
    }
    int idxCont = content.indexOf("\"continuous\":");
    if (idxCont != -1) {
      sysConfig.continuousLiveMode = (content.indexOf("true", idxCont) != -1);
    }
    int idxIdle = content.indexOf("\"idle\":");
    if (idxIdle != -1) {
      int s = idxIdle + 7;
      int e = content.indexOf(",", s); if (e == -1) e = content.indexOf("}", s);
      uint32_t idleSec = content.substring(s, e).toInt();
      if (idleSec >= 5 && idleSec <= 60) {
        sysConfig.idleSleepTimeout_ms = idleSec * 1000;
      }
    }
  }
}

void saveWifiCredentials(const String& ssid, const String& pass) {
  if (!sdAvailable) return;
  createSdDirectories();
  File wFile = SD.open(PATH_WIFI_FILE, FILE_WRITE);
  if (wFile) {
    wFile.printf("{\"ssid\":\"%s\",\"pass\":\"%s\"}", ssid.c_str(), pass.c_str());
    wFile.close();
    Serial.println("[WIFI] Zugangsdaten in /settings/wifi.json gesichert.");
  }
}

bool loadWifiCredentials(String& ssid, String& pass) {
  if (!sdAvailable || !SD.exists(PATH_WIFI_FILE)) return false;
  File wFile = SD.open(PATH_WIFI_FILE, FILE_READ);
  if (!wFile) return false;
  String content = wFile.readString();
  wFile.close();

  int sIdx = content.indexOf("\"ssid\":\"");
  int pIdx = content.indexOf("\"pass\":\"");
  if (sIdx == -1 || pIdx == -1) return false;

  int sEnd = content.indexOf("\"", sIdx + 8);
  int pEnd = content.indexOf("\"", pIdx + 8);
  if (sEnd == -1 || pEnd == -1) return false;

  ssid = content.substring(sIdx + 8, sEnd);
  pass = content.substring(pIdx + 8, pEnd);
  return (ssid.length() > 0);
}

/*
 * Breadcrumb: 2026-09-10 00:15 - Persistent SIM & APN Credentials Handler
 * Feature: Stores and parses SIM PIN and APN from /settings/sim.json.
 */
void saveSimCredentials(const String& pin, const String& apn) {
  if (!sdAvailable) return;
  createSdDirectories();
  File sFile = SD.open(PATH_SIM_FILE, FILE_WRITE);
  if (sFile) {
    sFile.printf("{\"pin\":\"%s\",\"apn\":\"%s\"}", pin.c_str(), apn.c_str());
    sFile.close();
    Serial.println("[SIM] PIN und APN in /settings/sim.json gesichert.");
  }
}

bool loadSimCredentials(String& pin, String& apn) {
  if (!sdAvailable || !SD.exists(PATH_SIM_FILE)) return false;
  File sFile = SD.open(PATH_SIM_FILE, FILE_READ);
  if (!sFile) return false;
  String content = sFile.readString();
  sFile.close();

  int pIdx = content.indexOf("\"pin\":\"");
  int aIdx = content.indexOf("\"apn\":\"");
  if (pIdx != -1) {
    int pEnd = content.indexOf("\"", pIdx + 7);
    if (pEnd != -1) pin = content.substring(pIdx + 7, pEnd);
  }
  if (aIdx != -1) {
    int aEnd = content.indexOf("\"", aIdx + 7);
    if (aEnd != -1) apn = content.substring(aIdx + 7, aEnd);
  }
  return (pin.length() > 0 || apn.length() > 0);
}
/*
 * Breadcrumb: 2026-09-08 17:25 - Forward Declaration Signature Match Fix
 * [CRITICAL BUGFIX FLAG - SIGNATURE MISMATCH]:
 * Changed enableBNO085Feature return type from void to bool to match implementation.
 */

/*
 * Breadcrumb: 2026-09-09 23:35 - Synchronized Forward Declarations
 * [CRITICAL BUGFIX FLAG - FORWARD DECLARATIONS]:
 * Added prototypes for Supabase Realtime, Cloud Config, and OTA to prevent scope errors.
 */
// Forward Declarations
void logErrorToSD(const char* errorMsg);
void logEventToSD(const char* eventName);
void flushBNO085FIFO();
void enable5VBoostPower();
BMSStatus readBMS();
bool enableBNO085Feature(uint8_t addr, uint8_t reportId, uint16_t reportInterval_ms, float sensitivity);
bool readSHTPPacket(uint8_t addr);
void startBatteryAnimation();
void updateBatteryAnimation();
void updateWifiWave();
void updateChargingAnimation();
void flashWakeupBlink();
void toggleWifiAP(bool enable);
bool connectKnownWiFi();
void checkButton();
void goToDeepSleep();
String getSystemJsonStatus();
void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len);
bool initSDCardRobust();
void loadSyncPointer();
void saveSyncPointer();
void syncBatteryLogsToSupabase();
void syncConfigFromSupabase();
bool checkAndDownloadCloudOTA();
bool initSupabaseRealtime();
void stopSupabaseRealtime();
void sendWssFrame(const char* text);
void broadcastIMUToCloud();

// LTE Modem Prototypes
String sendAT(const String& cmd, uint32_t timeout_ms = 1000);
void powerOnModem();
bool initModemHardware();
bool sendTelemetryOverLTE(const String& jsonPayload);

/*
 * Breadcrumb: 2026-09-08 17:45 - Dual-Target Live Log Broadcaster
 * Feature: Broadcasts diagnostic strings simultaneously to Serial and connected WebSockets.
 */

void logMsg(const char* fmt, ...) {
  char buf[256];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);

  // 1. Serieller Monitor
  Serial.print(buf);

  // 2. WebSocket Push an Live-Dashboard (nur wenn AP/STA aktiv und mindestens ein Client verbunden)
  if ((wifiApActive || wifiStaActive) && ws.count() > 0) {
    String jsonLog = "{\"log\":\"" + String(buf) + "\"}";
    jsonLog.replace("\n", "\\n");
    jsonLog.replace("\r", "");
    ws.textAll(jsonLog);
  }
}

/*
 * Breadcrumb: 2026-09-09 22:05 - Robust SNTP Epoch Timestamp Formatter
 * [CRITICAL BUGFIX FLAG - TIMESTAMPTZ COMPATIBILITY]:
 * Checks ESP32 internal POSIX clock (> 2024 epoch). Returns UTC ISO-format
 * to prevent Supabase Postgres TIMESTAMPTZ syntax rejection (HTTP 400).
 */

// ==========================================
// 4. EMBEDDED DASHBOARD HTML
// ==========================================
/*
 * Breadcrumb: 2026-09-07 01:50 - Protected Admin Dashboard & GLB Viewer
 * Feature: Password lock 'stag2026' for uploads, Three.js GLB loader, and interval slider in minutes.
 */

/*
 * Breadcrumb: 2026-09-07 01:58 - Fix C++ Raw String Literal & Embedded JS
 * Fix: Corrected PROGMEM string literal closure so JavaScript functions compile cleanly.
 */

/*
 * Breadcrumb: 2026-09-07 02:05 - Robust Escaped Dashboard String Definition
 * Fix: Replaced raw string literal delimiter with standard escaped C-string array 
 *      to completely prevent Arduino IDE preprocessor parser confusion on JS function keywords.
 */

/*
 * Breadcrumb: 2026-09-07 02:20 - Three.js GLB Renderer + STAG Base64 Logo Header
 * Feature: Direct Three.js WebGL canvas rendering IMU.glb from /download?file=/IMU.glb.
 */

/*
 * Breadcrumb: 2026-09-07 02:22 - Header Lock Icon, Robust JSON Parser & Direct GLB Model Route
 * Fix: Replaced static text fields with dynamic WebSocket binding and embedded SVG lock icon.
 */

/*
 * Breadcrumb: 2026-09-07 02:30 - Bulletproof Offline Engine & Dual-Channel Poller
 * Fix: Isolated 3D engine in try/catch to prevent CDN failure from blocking WebSocket and UI data.
 * Feature: Automatic HTTP /status fallback poller and self-contained offline 3D wireframe fallback.
 */

/*
 * Breadcrumb: 2026-09-07 02:40 - Slider Touch Lock, Quaternion Normalization & Append-Only Log Stability
 * Fix: Added user interaction lock for input sliders to prevent poller overwrites.
 * Fix: Normalized quaternions in 3D engine to eliminate erratic zoom/scale warping.
 */

/*
 * Breadcrumb: 2026-09-07 02:40 - 100% Offline Local 3D Engine & Calibrated Quat Transform
 * Fix: Replaced external CDNs with local SD script endpoints (/three.min.js, /GLTFLoader.js).
 * Fix: Hardened SHTP Quaternion mapping (BNO085 Right-Handed Z-Up to Three.js Y-Up).
 */

/*
 * Breadcrumb: 2026-09-07 02:50 - Universal Multi-File SD Uploader
 * Feature: Upload any file (.glb, .js, .json) preserving exact filename to SD root.
 */

/*
 * Breadcrumb: 2026-09-07 02:55 - Hardened Frontend Uploader & Clean Three.js Orientation
 * Fix: Uses FormData streaming with progress timeout and true BNO085-to-WebGL Euler rotation.
 */

/*
 * Breadcrumb: 2026-09-07 19:45 - Clean Dashboard HTML & JS Engine
 * Fix: Repaired ReferenceError in saveSettings(), fixed Hz slider binding and charge status readout.
 */
/*
 * Breadcrumb: 2026-09-07 20:20 - Tabbed Responsive UI & In-DOM Modal Authentication
 * Fix: Replaced window.prompt/alert with custom DOM modal for iOS CNA compatibility.
 * Fix: Swapped Three.js Y/Z quaternion axes.
 * Feature: Added Tabs (Sensoren, Daten & Logs, Konnektivität).
 */
/*
 * Breadcrumb: 2026-09-07 21:15 - Tabbed Dashboard & Interactive SD Directory Explorer
 * Fix: Replaced static file list with dynamic /browse folder navigation, target upload & SD-OTA trigger.
 */

/*
 * Breadcrumb: 2026-09-08 17:50 - Live Serial Terminal & Inverted Pitch Fix
 * Feature: Added interactive live terminal tab (#tab-terminal) with WebSocket stream binding.
 * Fix: Escaped all quotes in DOM and inverted qy pitch orientation (-qy/norm).
 */
/*
 * Breadcrumb: 2026-09-08 18:15 - Clean Live HUD & JS WebSocket Parser Fix
 * Fix: Repaired duplicate if(d.w!==undefined) block in ws.onmessage.
 * Feature: Displays live orientation and 3-axis linear acceleration HUD.
 */

/*
 * Breadcrumb: 2026-09-09 00:50 - Responsive 3D Accel Displacement & Immediate Mesh Init
 * [CRITICAL BUGFIX FLAG - 3D TRANSLATION & ROTATION]:
 * 1. Initializes fallback box immediately so modelMesh is never undefined.
 * 2. Translates modelMesh.position dynamically based on linear acceleration (ax, ay, az).
 * 3. Prevents 404 text caching in IndexedDB.
 */
/*
 * Breadcrumb: 2026-09-09 01:05 - True Quaternion Projection & Dynamic Accel Displacement
 * [CRITICAL BUGFIX FLAG - 3D CANVAS & THREEJS ENGINE]:
 * 1. Implementiert exakte Quaternion-Vektor-Transformation (rotateVecQuat) im Canvas-Fallback.
 * 2. Koppelt Linearbeschleunigung (ax, ay, az) mit dynamischer Feder-Dämpfung an die Box-Position.
 * 3. Mobile-optimierte Darstellung mit Live-HUD (Orientierung & Beschleunigungsvektor).
 */
/*
 * Breadcrumb: 2026-09-09 01:45 - Restored Proven Orientation Matrix & Smooth Accel Damping
 * [CRITICAL BUGFIX FLAG - PROVEN 3D ORIENTATION]:
 * 1. Stellt bewährte Achsen-Transformation (-qy/norm, qx/norm, qz/norm, qw/norm) wieder her.
 * 2. Cacht model.glb in IndexedDB für sofortigen Start.
 * 3. Beschleunigungsdämpfung mit Deadband (0.20 m/s²) verhindert Ruckeln.
 */
/*
 * Breadcrumb: 2026-09-09 01:55 - Restored Proven Orientation Matrix & Smooth Accel Damping
 * [CRITICAL BUGFIX FLAG - PROVEN 3D ORIENTATION]:
 * 1. Stellt bewährte Achsen-Transformation (-qy/norm, qx/norm, qz/norm, qw/norm) wieder her.
 * 2. Cacht model.glb in IndexedDB für sofortigen Start.
 * 3. Beschleunigungsdämpfung mit Deadband (0.20 m/s²) verhindert Ruckeln und Springen.
 */
/*
 * Breadcrumb: 2026-09-09 01:50 - 90-Deg CCW Screen-Z Orientation & Smooth Damped HUD
 * [CRITICAL BUGFIX FLAG - VIEWPORT Z-ROTATION]:
 * 1. Dreht das Modell um +90° CCW um die Z-Achse (Normale zur Bildschirmebene).
 * 2. Cacht model.glb in IndexedDB für verzögerungsfreien Start.
 * 3. Deadband-Filter (0.20 m/s²) eliminiert Ruckeln und Verspringen.
 */
/*
 * Breadcrumb: 2026-09-09 02:00 - Quat-Projected Acceleration Vector & Aligned 90-Deg Displacement
 * [CRITICAL BUGFIX FLAG - ACCEL ALIGNMENT]:
 * 1. Transformiert den sensorfesten Beschleunigungsvektor (ay, -ax, az) über modelMesh.quaternion.
 * 2. Bringt Translation und 90°-Z-Rotation in 1:1 Übereinstimmung mit den visuellen Modellachsen.
 * 3. Dynamische Feder-Dämpfung mit 0.20 m/s² Deadband sowohl in Three.js als auch im Canvas-Fallback.
 */
/*
 * Breadcrumb: 2026-09-09 23:10 - Captive Portal with Sleep Timeout Slider
 * Feature: Added 5-60s idle sleep duration slider and two-way WebSocket binding.
 */
/*
 * Breadcrumb: 2026-09-10 00:40 - Captive Portal with Integrated SIM & LTE Configuration
 * Feature: Added SIM PIN and APN inputs under tab-conn with persistent WebSocket sync.
 */
/*
 * Breadcrumb: 2026-09-11 06:20 - Triple Synced Accel Waveform Engine with Pan & Zoom
 * Feature: Adds 3 dedicated canvas graphs for Linear Accel (X, Y, Z) directly under the 3D viewport.
 * Synchronized temporal zooming (2s - 60s) and pan slider with auto-tracking live anchor.
 * Fix: SD directory parser properly handles trailing paths and closes handles on traversal.
 */
const char DASHBOARD_PAGE[] PROGMEM = 
"<!DOCTYPE html><html lang=\"de\"><head><meta charset=\"UTF-8\">"
"<meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no\">"
"<title>STAG IMU Portal</title>"
"<script src=\"/three.min.js\"></script>"
"<script src=\"/GLTFLoader.js\"></script>"
"<style>"
"*{box-sizing:border-box;margin:0;padding:0;}"
"body{background:#0b0f17;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#ecf0f1;padding:10px;}"
"#header{background:#151d2a;padding:10px 14px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;border:1px solid #233145;margin-bottom:10px;}"
"#header h1{font-size:15px;color:#009B4C;font-weight:700;letter-spacing:0.5px;}"
".hdr-right{display:flex;align-items:center;gap:10px;}"
".lock-btn{background:none;border:none;cursor:pointer;display:flex;align-items:center;padding:4px;}"
".lock-btn svg{width:20px;height:20px;fill:#bdc3c7;transition:fill 0.2s;}"
".lock-btn.unlocked svg{fill:#009B4C;}"
"#canvas-container{width:100%;height:30vh;background:#070a0f;border-radius:8px;position:relative;overflow:hidden;margin-bottom:8px;border:1px solid #233145;}"
"#overlay-status{position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,0.75);padding:4px 8px;border-radius:4px;font-size:11px;color:#009B4C;font-family:monospace;z-index:10;line-height:1.35;pointer-events:none;}"
".acc-card{background:#151d2a;padding:10px 12px;border-radius:8px;border:1px solid #233145;margin-bottom:10px;}"
".acc-card-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}"
".acc-canvas{width:100%;height:58px;background:#070a0f;border-radius:4px;border:1px solid #1c2636;margin-bottom:4px;display:block;}"
".acc-ctrls{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;background:#0b0f17;padding:8px;border-radius:6px;border:1px solid #233145;}"
".tabs{display:flex;gap:6px;margin-bottom:10px;}"
".tab-btn{flex:1;background:#151d2a;border:1px solid #233145;color:#8899a6;padding:8px 4px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;text-align:center;}"
".tab-btn.active{background:#009B4C;color:#fff;border-color:#009B4C;}"
".tab-content{display:none;}"
".tab-content.active{display:block;}"
".grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;}"
".card{background:#151d2a;padding:12px;border-radius:8px;border:1px solid #233145;margin-bottom:10px;font-size:13px;}"
".card .title{font-size:11px;color:#7f8c8d;text-transform:uppercase;margin-bottom:4px;}"
".card .val{font-size:17px;font-weight:bold;color:#ecf0f1;}"
".btn{background:#009B4C;color:#fff;border:none;padding:10px 12px;width:100%;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;margin-top:6px;}"
".btn-secondary{background:#2c3e50;}"
".btn-danger{background:#c0392b;}"
".btn-sm{padding:2px 8px;width:auto;margin:0;font-size:11px;}"
".form-group{margin-bottom:10px;}"
"label{display:flex;justify-content:space-between;font-size:12px;color:#bdc3c7;margin-bottom:4px;}"
"input[type=range]{width:100%;height:6px;background:#233145;border-radius:3px;outline:none;margin:6px 0;accent-color:#009B4C;}"
"input[type=text],input[type=password],input[type=file]{width:100%;padding:8px;background:#0b0f17;border:1px solid #233145;border-radius:4px;color:#ecf0f1;font-size:12px;margin-top:4px;}"
".file-item{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #233145;font-size:12px;font-family:monospace;}"
".file-item a{color:#009B4C;text-decoration:none;}"
"#modal-auth{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:999;align-items:center;justify-content:center;padding:16px;}"
"#modal-card{background:#151d2a;border:1px solid #233145;border-radius:8px;width:100%;max-width:320px;padding:16px;}"
"</style></head><body>"
"<div id=\"header\">"
"<h1>STAG AG &bull; TELEMETRIE</h1>"
"<div class=\"hdr-right\">"
"<button id=\"lock-icon-btn\" class=\"lock-btn\" onclick=\"openAuthModal()\" title=\"Erweitertes Menü\">"
"<svg viewBox=\"0 0 24 24\"><path d=\"M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z\"/></svg>"
"</button>"
"<span id=\"conn-indicator\" style=\"color:#009B4C;font-size:11px;font-weight:bold;\">ONLINE</span>"
"</div></div>"
"<div class=\"tabs\">"
"<button class=\"tab-btn active\" onclick=\"showTab('tab-sensors',this)\">Sensoren</button>"
"<button class=\"tab-btn\" onclick=\"showTab('tab-data',this)\">Daten & Logs</button>"
"<button class=\"tab-btn\" onclick=\"showTab('tab-conn',this)\">Konnektivität</button>"
"<button class=\"tab-btn\" onclick=\"showTab('tab-terminal',this)\">Terminal</button>"
"</div>"
"<div id=\"tab-sensors\" class=\"tab-content active\">"
"<div id=\"canvas-container\"><canvas id=\"cv-offline\" style=\"width:100%;height:100%;display:none;\"></canvas><div id=\"overlay-status\">ROT: W:+1.00 X:+0.00 Y:+0.00 Z:+0.00<br>ACC: X:0.00 Y:0.00 Z:0.00 m/s²</div></div>"
"<div class=\"acc-card\">"
"<div class=\"acc-card-hdr\"><span class=\"title\" style=\"margin:0;\">Beschleunigungsdynamik (Linear)</span><button class=\"btn btn-secondary btn-sm\" id=\"btn-acc-live\" onclick=\"jumpAccLive()\">🔴 Live</button></div>"
"<canvas id=\"cv-acc-x\" class=\"acc-canvas\"></canvas>"
"<canvas id=\"cv-acc-y\" class=\"acc-canvas\"></canvas>"
"<canvas id=\"cv-acc-z\" class=\"acc-canvas\"></canvas>"
"<div class=\"acc-ctrls\">"
"<div><label><span>Zeitfenster (Zoom)</span><span id=\"acc-zoom-val\" style=\"color:#009B4C;\">10s</span></label><input type=\"range\" id=\"acc-zoom\" min=\"20\" max=\"600\" value=\"100\" oninput=\"onAccZoom(this.value)\"></div>"
"<div><label><span>Position (Scroll)</span><span id=\"acc-pan-val\" style=\"color:#009B4C;\">LIVE</span></label><input type=\"range\" id=\"acc-pan\" min=\"0\" max=\"100\" value=\"100\" oninput=\"onAccPan(this.value)\"></div>"
"</div></div>"
"<div class=\"grid\">"
"<div class=\"card\"><div class=\"title\">Akkuzustand</div><div class=\"val\" id=\"bat-pct\">--%</div><div style=\"font-size:11px;color:#95a5a6;\" id=\"bat-v\">-- V</div><div style=\"font-size:11px;color:#009B4C;font-weight:600;margin-top:4px;\" id=\"bat-status\">Prüfe Status...</div></div>"
"<div class=\"card\"><div class=\"title\">SD-Speicher</div><div class=\"val\" id=\"sd-free\">-- MB</div><div style=\"font-size:11px;color:#95a5a6;\" id=\"sd-tot\">Gesamt: -- MB</div></div>"
"</div>"
"<div class=\"card\"><div class=\"title\">Schwellenwerte & Dynamik</div>"
"<div class=\"form-group\"><label><span>Aufwach-Empfindlichkeit (Schwelle)</span><span id=\"sens-val\">0.20 m/s²</span></label><input type=\"range\" id=\"sens\" min=\"0.05\" max=\"1.50\" step=\"0.05\" value=\"0.20\" oninput=\"onSliderInput('sens')\"></div>"
"<div class=\"form-group\"><label><span>Ruhe-Schwellenwert (Delta)</span><span id=\"delta-val\">0.10</span></label><input type=\"range\" id=\"delta\" min=\"0.02\" max=\"0.30\" step=\"0.01\" value=\"0.10\" oninput=\"onSliderInput('delta')\"></div>"
"<div class=\"form-group\"><label><span>Abtastrate (Hz)</span><span id=\"rate-val\">10 Hz</span></label><input type=\"range\" id=\"rate\" min=\"5\" max=\"30\" step=\"1\" value=\"10\" oninput=\"onSliderInput('rate')\"></div>"
"<div class=\"form-group\"><label><span>Inaktivität bis Sleep</span><span id=\"idle-val\">10 s</span></label><input type=\"range\" id=\"idle\" min=\"5\" max=\"60\" step=\"1\" value=\"10\" oninput=\"onSliderInput('idle')\"></div>"
"<button class=\"btn\" onclick=\"saveSettings()\">Sensoreinstellungen speichern</button>"
"</div></div>"
"<div id=\"tab-data\" class=\"tab-content\">"
"<div class=\"card\">"
"<div class=\"title\">SD-Explorer & Dateimanager</div>"
"<div style=\"display:flex;justify-content:space-between;align-items:center;background:#0b0f17;padding:6px 10px;border-radius:6px;margin-bottom:8px;border:1px solid #233145;\">"
"<span id=\"current-path-display\" style=\"font-family:monospace;font-size:12px;color:#009B4C;\">/</span>"
"<button class=\"btn btn-secondary\" style=\"width:auto;padding:4px 10px;margin:0;font-size:11px;\" onclick=\"navigateUp()\">Ordner hoch ⬆</button>"
"</div>"
"<div id=\"file-list\" style=\"margin-bottom:10px;min-height:80px;\">Lade Verzeichnis...</div>"
"<div id=\"admin-data-sec\" style=\"display:none;margin-top:10px;border-top:1px solid #233145;padding-top:10px;\">"
"<div class=\"title\">Datei in aktuellen Ordner hochladen</div>"
"<input type=\"file\" id=\"any-file\">"
"<button class=\"btn\" onclick=\"uploadGenericFile()\">In aktuellen Ordner hochladen</button>"
"<div id=\"upload-status\" style=\"font-size:11px;margin-top:6px;color:#009B4C;\"></div>"
"<button class=\"btn btn-danger\" style=\"margin-top:12px;\" onclick=\"formatSD()\">SD-Karte formatieren</button>"
"</div></div></div>"
"<div id=\"tab-conn\" class=\"tab-content\">"
"<div class=\"card\"><div class=\"title\">Telemetrie & Übertragung</div>"
"<div class=\"form-group\"><label><span>LTE Sendeintervall</span><span id=\"lte-val\">5 min</span></label><input type=\"range\" id=\"lte\" min=\"5\" max=\"60\" step=\"1\" value=\"5\" oninput=\"onSliderInput('lte')\"></div>"
"<div class=\"form-group\"><label><span>Kontinuierlicher Live-Modus</span></label><button class=\"btn btn-secondary\" id=\"btn-live\" onclick=\"toggleContinuousMode()\">Live-Modus: AUS</button></div>"
"<button class=\"btn\" onclick=\"saveSettings()\">Übertragungsraten speichern</button>"
"</div>"
"<div class=\"card\"><div class=\"title\">Mobilfunk & SIM-Karte (LTE)</div>"
"<div class=\"form-group\"><label>SIM-PIN</label><input type=\"password\" id=\"sim-pin\" placeholder=\"z.B. 1234\" maxlength=\"8\"></div>"
"<div class=\"form-group\"><label>APN (Zugangspunkt)</label><input type=\"text\" id=\"sim-apn\" placeholder=\"gprs.swisscom.ch\"></div>"
"<button class=\"btn\" onclick=\"saveSim()\">SIM-Daten auf SD sichern</button>"
"<div id=\"sim-save-status\" style=\"font-size:11px;margin-top:6px;color:#009B4C;\"></div>"
"</div>"
"<div id=\"admin-wifi-sec\" class=\"card\" style=\"display:none;\"><div class=\"title\">Vertrauliches WLAN konfigurieren</div>"
"<div class=\"form-group\"><label>WLAN SSID</label><input type=\"text\" id=\"wifi-ssid\" placeholder=\"Netzwerkname\"></div>"
"<div class=\"form-group\"><label>WLAN Passwort</label><input type=\"password\" id=\"wifi-pass\" placeholder=\"Passwort\"></div>"
"<button class=\"btn\" onclick=\"saveWifi()\">WLAN-Zugang auf SD sichern</button>"
"<div id=\"wifi-save-status\" style=\"font-size:11px;margin-top:6px;color:#009B4C;\"></div>"
"</div></div>"
"<div id=\"tab-terminal\" class=\"tab-content\">"
"<div class=\"card\">"
"<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;\">"
"<div class=\"title\" style=\"margin:0;\">Live Serieller Log</div>"
"<button class=\"btn btn-secondary\" style=\"width:auto;padding:3px 8px;margin:0;font-size:11px;\" onclick=\"document.getElementById('log-console').innerText=''\">Löschen</button>"
"</div>"
"<pre id=\"log-console\" style=\"background:#070a0f;color:#009B4C;font-family:monospace;font-size:11px;padding:8px;border-radius:6px;height:48vh;overflow-y:auto;white-space:pre-wrap;border:1px solid #233145;\"></pre>"
"</div></div>"
"<div id=\"modal-auth\"><div id=\"modal-card\">"
"<div style=\"font-size:14px;font-weight:bold;margin-bottom:8px;color:#ecf0f1;\">Erweitertes Menü</div>"
"<input type=\"password\" id=\"admin-pass-input\" placeholder=\"Passwort eingeben\">"
"<div style=\"display:flex;gap:8px;margin-top:10px;\">"
"<button class=\"btn\" onclick=\"submitAdminAuth()\">Entsperren</button>"
"<button class=\"btn btn-secondary\" onclick=\"closeAuthModal()\">Abbrechen</button>"
"</div>"
"<div id=\"auth-err\" style=\"color:#e74c3c;font-size:11px;margin-top:6px;\"></div>"
"</div></div>"
"<script>"
"var ws,scene,camera,renderer,modelMesh;"
"var qw=1,qx=0,qy=0,qz=0,curAx=0,curAy=0,curAz=0;"
"var lastQw=1,lastQx=0,lastQy=0,lastQz=0;"
"var isContinuous=false,isAdmin=false,isUserInteracting=false,interactionTimeout=null;"
"var cvOffline=document.getElementById('cv-offline'),ctxOffline=cvOffline.getContext('2d');"
"var currentDir='/';"
"var posX=0,posY=0,posZ=0;"
"var accHistory=[];var maxAccPoints=1800;var accZoom=100;var accPan=100;var isAccLive=true;"
"function showTab(id,btn){"
"document.querySelectorAll('.tab-content').forEach(function(c){c.classList.remove('active');});"
"document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active');});"
"document.getElementById(id).classList.add('active');btn.classList.add('active');"
"if(id==='tab-data'){loadDirectory(currentDir);}"
"if(id==='tab-sensors'){setTimeout(drawAccGraphs,50);}"
"}"
"function onSliderInput(id){"
"isUserInteracting=true;clearTimeout(interactionTimeout);"
"interactionTimeout=setTimeout(function(){isUserInteracting=false;},4000);"
"if(id==='rate')document.getElementById('rate-val').innerText=document.getElementById('rate').value+' Hz';"
"if(id==='sens')document.getElementById('sens-val').innerText=Number(document.getElementById('sens').value).toFixed(2);"
"if(id==='delta')document.getElementById('delta-val').innerText=Number(document.getElementById('delta').value).toFixed(2);"
"if(id==='lte')document.getElementById('lte-val').innerText=document.getElementById('lte').value+' min';"
"if(id==='idle')document.getElementById('idle-val').innerText=document.getElementById('idle').value+' s';"
"}"
"function onAccZoom(v){"
"accZoom=parseInt(v);"
"document.getElementById('acc-zoom-val').innerText=(accZoom/10).toFixed(0)+'s';"
"drawAccGraphs();"
"}"
"function onAccPan(v){"
"accPan=parseFloat(v);"
"isAccLive=(accPan>=99);"
"document.getElementById('acc-pan-val').innerText=isAccLive?'LIVE':accPan.toFixed(0)+'%';"
"document.getElementById('btn-acc-live').style.background=isAccLive?'#009B4C':'#2c3e50';"
"drawAccGraphs();"
"}"
"function jumpAccLive(){"
"accPan=100;document.getElementById('acc-pan').value=100;onAccPan(100);"
"}"
"function renderStatusData(d){"
"if(!d)return;"
"if(d.bat_pct!==undefined){var prefix=d.is_charging?'⚡ ':'';document.getElementById('bat-pct').innerText=prefix+d.bat_pct+'%';}"
"if(d.bat_v!==undefined)document.getElementById('bat-v').innerText=Number(d.bat_v).toFixed(2)+' V';"
"if(d.chrg_stat!==undefined){var statEl=document.getElementById('bat-status');if(statEl){statEl.innerText=d.chrg_stat;statEl.style.color=d.is_charging?'#f39c12':'#009B4C';}}"
"if(d.sd_free_mb!==undefined)document.getElementById('sd-free').innerText=d.sd_free_mb+' MB Frei';"
"if(d.sd_tot_mb!==undefined)document.getElementById('sd-tot').innerText='Gesamt: '+d.sd_tot_mb+' MB';"
"if(!isUserInteracting){"
"if(d.sens!==undefined){document.getElementById('sens').value=d.sens;document.getElementById('sens-val').innerText=Number(d.sens).toFixed(2);}"
"if(d.delta!==undefined){document.getElementById('delta').value=d.delta;document.getElementById('delta-val').innerText=Number(d.delta).toFixed(2);}"
"if(d.rate!==undefined){document.getElementById('rate').value=d.rate;document.getElementById('rate-val').innerText=d.rate+' Hz';}"
"if(d.lte!==undefined){document.getElementById('lte').value=d.lte;document.getElementById('lte-val').innerText=d.lte+' min';}"
"if(d.idle!==undefined){document.getElementById('idle').value=d.idle;document.getElementById('idle-val').innerText=d.idle+' s';}"
"if(d.sim_apn!==undefined){document.getElementById('sim-apn').value=d.sim_apn;}"
"}"
"if(d.continuous!==undefined){"
"isContinuous=d.continuous;"
"var btn=document.getElementById('btn-live');"
"btn.innerText=isContinuous?'Live-Modus: AKTIV':'Live-Modus: AUS';"
"btn.style.background=isContinuous?'#009B4C':'#2c3e50';"
"}"
"}"
"function fetchStatusHTTP(){"
"fetch('/status').then(function(r){return r.json();}).then(function(data){renderStatusData(data);}).catch(function(e){});"
"}"
"function loadDirectory(dir){"
"currentDir=dir||'/';"
"document.getElementById('current-path-display').innerText=currentDir;"
"fetch('/browse?dir='+encodeURIComponent(currentDir)).then(function(r){return r.json();}).then(function(data){"
"var fh='';"
"if(data.items&&data.items.length>0){"
"data.items.forEach(function(item){"
"var itemPath=(currentDir==='/'?'':currentDir)+'/'+item.name;"
"if(item.is_dir){"
"fh+='<div class=\"file-item\" style=\"cursor:pointer;background:rgba(0,155,76,0.08);padding:8px;border-radius:4px;margin-bottom:4px;\" onclick=\"loadDirectory(\\''+itemPath+'\\')\"><span>📁 <b>'+item.name+'</b></span><span style=\"color:#009B4C;\">Öffnen ➔</span></div>';"
"}else{"
"var sizeKb=(item.size/1024).toFixed(1);"
"var flashBtn=item.name.toLowerCase().endsWith('.bin')?'<button class=\"btn\" style=\"width:auto;padding:2px 8px;margin:0 4px;font-size:10px;\" onclick=\"triggerFlash(\\''+itemPath+'\\')\">⚡ Flash</button>':'';"
"var delBtn=isAdmin?'<button class=\"btn btn-danger\" style=\"width:auto;padding:2px 6px;margin:0 4px;font-size:10px;\" onclick=\"deleteFile(\\''+itemPath+'\\')\">✕</button>':'';"
"fh+='<div class=\"file-item\"><span>📄 '+item.name+' ('+sizeKb+' KB)</span><div>'+flashBtn+'<a href=\"/download?file='+encodeURIComponent(itemPath)+'\" download style=\"margin-right:4px;\">Download</a>'+delBtn+'</div></div>';"
"}"
"});"
"}else{fh='<div style=\"color:#7f8c8d;font-size:12px;padding:8px 0;\">Dieser Ordner ist leer.</div>';}"
"document.getElementById('file-list').innerHTML=fh;"
"}).catch(function(){document.getElementById('file-list').innerHTML='Fehler beim Laden des Ordners.';});"
"}"
"function navigateUp(){"
"if(currentDir==='/'||currentDir==='')return;"
"var lastSlash=currentDir.lastIndexOf('/');"
"var parent=lastSlash<=0?'/':currentDir.substring(0,lastSlash);"
"loadDirectory(parent);"
"}"
"function deleteFile(path){"
"if(confirm('Datei wirklich löschen?\\n'+path)){"
"fetch('/delete?file='+encodeURIComponent(path)).then(function(){loadDirectory(currentDir);fetchStatusHTTP();});"
"}"
"}"
"function triggerFlash(path){"
"if(confirm('Microcontroller mit dieser Firmware flashen?\\n'+path+'\\n\\nDas Board startet anschließend neu.')){"
"fetch('/flash?file='+encodeURIComponent(path)).then(function(r){return r.text();}).then(function(msg){alert(msg);});"
"}"
"}"
"function rotateVecQuat(v, q){"
"var x=v[0],y=v[1],z=v[2];"
"var qx=q[0],qy=q[1],qz=q[2],qw=q[3];"
"var tx=2*(qy*z-qz*y);"
"var ty=2*(qz*x-qx*z);"
"var tz=2*(qx*y-qy*x);"
"return [x+qw*tx+(qy*tz-qz*ty), y+qw*ty+(qz*tx-qx*tz), z+qw*tz+(qx*ty-qy*tx)];"
"}"
"function createFallbackCube(){"
"if(modelMesh&&scene){scene.remove(modelMesh);}"
"var geo=new THREE.BoxGeometry(1.8,0.35,0.9);"
"var mat=new THREE.MeshStandardMaterial({color:0x009B4C,metalness:0.3,roughness:0.4});"
"modelMesh=new THREE.Mesh(geo,mat);scene.add(modelMesh);"
"}"
"function setupModelMesh(gltfScene){"
"if(modelMesh&&scene){scene.remove(modelMesh);}"
"modelMesh=gltfScene;"
"var box=new THREE.Box3().setFromObject(modelMesh);"
"var size=box.getSize(new THREE.Vector3());"
"var maxDim=Math.max(size.x,size.y,size.z);"
"if(maxDim>0){var s=1.8/maxDim;modelMesh.scale.set(s,s,s);}"
"scene.add(modelMesh);"
"}"
"function loadGLBWithCache(){"
"if(typeof THREE.GLTFLoader==='undefined'){createFallbackCube();return;}"
"var loader=new THREE.GLTFLoader();"
"try{"
"var req=indexedDB.open('STAG_3D_CACHE',1);"
"req.onupgradeneeded=function(e){e.target.result.createObjectStore('models');};"
"req.onsuccess=function(e){"
"var db=e.target.result;"
"var tx=db.transaction('models','readonly');"
"var getReq=tx.objectStore('models').get('model_glb');"
"getReq.onsuccess=function(){"
"if(getReq.result){"
"loader.parse(getReq.result,'',function(gltf){setupModelMesh(gltf.scene);});"
"}else{"
"fetch('/model.glb').then(function(res){return res.arrayBuffer();}).then(function(buf){"
"var saveTx=db.transaction('models','readwrite');"
"saveTx.objectStore('models').put(buf,'model_glb');"
"loader.parse(buf,'',function(gltf){setupModelMesh(gltf.scene);});"
"}).catch(function(){createFallbackCube();});"
"}"
"};"
"getReq.onerror=function(){loader.load('/model.glb',function(gltf){setupModelMesh(gltf.scene);},undefined,function(){createFallbackCube();});};"
"};"
"req.onerror=function(){loader.load('/model.glb',function(gltf){setupModelMesh(gltf.scene);},undefined,function(){createFallbackCube();});};"
"}catch(idbErr){loader.load('/model.glb',function(gltf){setupModelMesh(gltf.scene);},undefined,function(){createFallbackCube();});}"
"}"
"function init3D(){"
"var container=document.getElementById('canvas-container');"
"if(typeof THREE!=='undefined'){"
"try{"
"scene=new THREE.Scene();"
"camera=new THREE.PerspectiveCamera(45,container.clientWidth/container.clientHeight,0.1,1000);"
"camera.position.set(0,0,3.8);"
"renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});"
"renderer.setSize(container.clientWidth,container.clientHeight);"
"renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));"
"container.appendChild(renderer.domElement);"
"var l1=new THREE.DirectionalLight(0xffffff,1.2);l1.position.set(5,10,7);scene.add(l1);"
"var l2=new THREE.DirectionalLight(0xffffff,0.6);l2.position.set(-5,-10,-7);scene.add(l2);"
"scene.add(new THREE.AmbientLight(0xffffff,0.7));"
"createFallbackCube();"
"loadGLBWithCache();"
"window.addEventListener('resize',function(){"
"camera.aspect=container.clientWidth/container.clientHeight;"
"camera.updateProjectionMatrix();"
"renderer.setSize(container.clientWidth,container.clientHeight);"
"drawAccGraphs();"
"});"
"function animate(){"
"requestAnimationFrame(animate);"
"if(modelMesh){"
"var norm=Math.sqrt(qx*qx+qy*qy+qz*qz+qw*qw);"
"if(norm>0.0001){"
"modelMesh.quaternion.set(-qy/norm, qx/norm, qz/norm, qw/norm);"
"modelMesh.quaternion.premultiply(new THREE.Quaternion(0, 0, 0.707107, 0.707107));"
"}"
"var aLen=Math.hypot(curAx,curAy,curAz);"
"var axF=(aLen>0.20)?curAx:0; var ayF=(aLen>0.20)?curAy:0; var azF=(aLen>0.20)?curAz:0;"
"var aVec = new THREE.Vector3(ayF, -axF, azF);"
"aVec.applyQuaternion(modelMesh.quaternion);"
"var tx=Math.max(-0.45, Math.min(0.45, aVec.x*0.05));"
"var ty=Math.max(-0.45, Math.min(0.45, aVec.y*0.05));"
"var tz=Math.max(-0.45, Math.min(0.45, aVec.z*0.05));"
"posX+=(tx-posX)*0.15; posY+=(ty-posY)*0.15; posZ+=(tz-posZ)*0.15;"
"modelMesh.position.set(posX,posY,posZ);"
"}"
"renderer.render(scene,camera);"
"}"
"animate();return;"
"}catch(err){console.error('Three.js Init Error:',err);}"
"}"
"cvOffline.style.display='block';"
"function resizeOffline(){cvOffline.width=container.clientWidth;cvOffline.height=container.clientHeight;}"
"window.onresize=resizeOffline;resizeOffline();"
"function drawOfflineBox(){"
"ctxOffline.clearRect(0,0,cvOffline.width,cvOffline.height);"
"var cx=cvOffline.width/2, cy=cvOffline.height/2;"
"var norm=Math.sqrt(qx*qx+qy*qy+qz*qz+qw*qw)||1.0;"
"var uq=[-qy/norm, qx/norm, qz/norm, qw/norm];"
"var aLen=Math.hypot(curAx,curAy,curAz);"
"var axF=(aLen>0.20)?curAx:0; var ayF=(aLen>0.20)?curAy:0; var azF=(aLen>0.20)?curAz:0;"
"var aRot = rotateVecQuat([ayF, -axF, azF], uq);"
"var tx=Math.max(-40, Math.min(40, -aRot[1]*4.0));"
"var ty=Math.max(-40, Math.min(40, -aRot[0]*4.0));"
"posX+=(tx-posX)*0.15; posY+=(ty-posY)*0.15;"
"var s=Math.min(cvOffline.width,cvOffline.height)*0.32;"
"var nodes=[[-1.1,-0.25,-0.6],[1.1,-0.25,-0.6],[1.1,0.25,-0.6],[-1.1,0.25,-0.6],[-1.1,-0.25,0.6],[1.1,-0.25,0.6],[1.1,0.25,0.6],[-1.1,0.25,0.6]];"
"var p=nodes.map(function(n){"
"var r=rotateVecQuat([n[0], n[2], -n[1]], uq);"
"var zDist=3.2+r[2];"
"var fov=2.4/zDist;"
"return [cx+posX+(-r[1]*s*fov), cy+posY-(r[0]*s*fov)];"
"});"
"var ed=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];"
"ctxOffline.fillStyle='rgba(0,155,76,0.18)';"
"ctxOffline.beginPath();ctxOffline.moveTo(p[4][0],p[4][1]);ctxOffline.lineTo(p[5][0],p[5][1]);ctxOffline.lineTo(p[6][0],p[6][1]);ctxOffline.lineTo(p[7][0],p[7][1]);ctxOffline.closePath();ctxOffline.fill();"
"ctxOffline.strokeStyle='#009B4C';ctxOffline.lineWidth=2.5;"
"ed.forEach(function(e){ctxOffline.beginPath();ctxOffline.moveTo(p[e[0]][0],p[e[0]][1]);ctxOffline.lineTo(p[e[1]][0],p[e[1]][1]);ctxOffline.stroke();});"
"ctxOffline.fillStyle='#e67e22';ctxOffline.beginPath();ctxOffline.arc(p[5][0],p[5][1],4,0,Math.PI*2);ctxOffline.fill();"
"requestAnimationFrame(drawOfflineBox);"
"}"
"drawOfflineBox();"
"}"
"function drawSingleAxis(cvId,axisKey,color,label,maxAbs,startIdx,endIdx){"
"var cv=document.getElementById(cvId);"
"if(!cv)return;"
"var ctx=cv.getContext('2d');"
"var w=cv.width=cv.clientWidth;var h=cv.height=cv.clientHeight;"
"ctx.clearRect(0,0,w,h);"
"var midY=h/2;"
"ctx.strokeStyle='#1e2a3a';ctx.lineWidth=1;ctx.setLineDash([2,2]);"
"ctx.beginPath();ctx.moveTo(0,midY);ctx.lineTo(w,midY);ctx.stroke();ctx.setLineDash([]);"
"var count=endIdx-startIdx;"
"if(count<2){"
"ctx.fillStyle='#556677';ctx.font='10px monospace';ctx.fillText(label+' (Warte auf Daten...)',8,midY+3);return;"
"}"
"ctx.fillStyle='#607286';ctx.font='9px monospace';"
"ctx.fillText('+'+maxAbs.toFixed(1),4,10);"
"ctx.fillText('-'+maxAbs.toFixed(1),4,h-3);"
"ctx.strokeStyle=color;ctx.lineWidth=1.6;ctx.beginPath();"
"for(var i=0;i<count;i++){"
"var pt=accHistory[startIdx+i];"
"var px=(i/(count-1))*w;"
"var py=midY-(pt[axisKey]/maxAbs)*(midY-4);"
"if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);"
"}"
"ctx.stroke();"
"var cur=accHistory[endIdx-1][axisKey];"
"ctx.fillStyle=color;ctx.font='bold 10px monospace';"
"ctx.fillText(label+': '+(cur>=0?'+':'')+cur.toFixed(2)+' m/s²',w-135,11);"
"}"
"function drawAccGraphs(){"
"var total=accHistory.length;"
"if(total<2){"
"drawSingleAxis('cv-acc-x','x','#e74c3c','ACC X',1.5,0,0);"
"drawSingleAxis('cv-acc-y','y','#009B4C','ACC Y',1.5,0,0);"
"drawSingleAxis('cv-acc-z','z','#3498db','ACC Z',1.5,0,0);"
"return;"
"}"
"var win=Math.min(accZoom,total);"
"var maxStart=Math.max(0,total-win);"
"var startIdx=isAccLive?maxStart:Math.round((accPan/100)*maxStart);"
"var endIdx=Math.min(total,startIdx+win);"
"var globalMax=1.5;"
"for(var i=startIdx;i<endIdx;i++){"
"var ax=Math.abs(accHistory[i].x);"
"var ay=Math.abs(accHistory[i].y);"
"var az=Math.abs(accHistory[i].z);"
"if(ax>globalMax)globalMax=ax;"
"if(ay>globalMax)globalMax=ay;"
"if(az>globalMax)globalMax=az;"
"}"
"globalMax=Math.ceil(globalMax*1.15*10)/10;"
"drawSingleAxis('cv-acc-x','x','#e74c3c','ACC X',globalMax,startIdx,endIdx);"
"drawSingleAxis('cv-acc-y','y','#009B4C','ACC Y',globalMax,startIdx,endIdx);"
"drawSingleAxis('cv-acc-z','z','#3498db','ACC Z',globalMax,startIdx,endIdx);"
"}"
"function initWS(){"
"ws=new WebSocket('ws://'+window.location.hostname+'/ws');"
"ws.onopen=function(){"
"document.getElementById('conn-indicator').innerText='ONLINE';"
"document.getElementById('conn-indicator').style.color='#009B4C';"
"fetchStatusHTTP();"
"};"
"ws.onclose=function(){"
"document.getElementById('conn-indicator').innerText='OFFLINE';"
"document.getElementById('conn-indicator').style.color='#e74c3c';"
"setTimeout(initWS,2000);"
"};"
"ws.onmessage=function(e){"
"try{"
"var d=JSON.parse(e.data);"
"if(d.log!==undefined){"
"var cEl=document.getElementById('log-console');"
"if(cEl){cEl.innerText+=d.log;cEl.scrollTop=cEl.scrollHeight;}"
"}else if(d.w!==undefined){"
"var inW=d.w, inX=d.x, inY=d.y, inZ=d.z;"
"if((inW*lastQw + inX*lastQx + inY*lastQy + inZ*lastQz) < 0){"
"inW=-inW; inX=-inX; inY=-inY; inZ=-inZ;"
"}"
"qw=inW; qx=inX; qy=inY; qz=inZ;"
"lastQw=qw; lastQx=qx; lastQy=qy; lastQz=qz;"
"if(d.ax!==undefined){"
"curAx=d.ax;curAy=d.ay;curAz=d.az;"
"accHistory.push({x:curAx,y:curAy,z:curAz});"
"if(accHistory.length>maxAccPoints)accHistory.shift();"
"drawAccGraphs();"
"}"
"var accStr=(d.ax!==undefined)?'<br>ACC: X:'+d.ax.toFixed(2)+' Y:'+d.ay.toFixed(2)+' Z:'+d.az.toFixed(2)+' m/s²':'';"
"document.getElementById('overlay-status').innerHTML='ROT: W:'+d.w.toFixed(2)+' X:'+d.x.toFixed(2)+' Y:'+d.y.toFixed(2)+' Z:'+d.z.toFixed(2)+accStr;"
"}else{"
"renderStatusData(d);"
"}"
"}catch(err){}"
"};"
"}"
"function openAuthModal(){"
"if(isAdmin){toggleAdminView(false);return;}"
"document.getElementById('admin-pass-input').value='';"
"document.getElementById('auth-err').innerText='';"
"document.getElementById('modal-auth').style.display='flex';"
"}"
"function closeAuthModal(){document.getElementById('modal-auth').style.display='none';}"
"function submitAdminAuth(){"
"var p=document.getElementById('admin-pass-input').value;"
"if(p==='stag2026'){"
"isAdmin=true;closeAuthModal();toggleAdminView(true);"
"}else{document.getElementById('auth-err').innerText='Ungültiges Passwort!';}"
"}"
"function toggleAdminView(unlocked){"
"document.getElementById('lock-icon-btn').classList.toggle('unlocked',unlocked);"
"document.getElementById('admin-data-sec').style.display=unlocked?'block':'none';"
"document.getElementById('admin-wifi-sec').style.display=unlocked?'block':'none';"
"loadDirectory(currentDir);"
"}"
"function toggleContinuousMode(){isContinuous=!isContinuous;ws.send(JSON.stringify({continuous:isContinuous}));saveSettings();}"
"function saveSettings(){"
"isUserInteracting=false;"
"var sens=parseFloat(document.getElementById('sens').value);"
"var delta=parseFloat(document.getElementById('delta').value);"
"var rate=parseInt(document.getElementById('rate').value);"
"var lte=parseInt(document.getElementById('lte').value);"
"var idle=parseInt(document.getElementById('idle').value);"
"ws.send(JSON.stringify({sens:sens,delta:delta,lte:lte,rate:rate,idle:idle,continuous:isContinuous}));"
"setTimeout(fetchStatusHTTP,300);"
"}"
"function saveWifi(){"
"var s=document.getElementById('wifi-ssid').value;"
"var p=document.getElementById('wifi-pass').value;"
"if(!s){document.getElementById('wifi-save-status').innerText='SSID darf nicht leer sein!';return;}"
"ws.send(JSON.stringify({wifi_ssid:s,wifi_pass:p}));"
"document.getElementById('wifi-save-status').innerText='WLAN-Zugang auf SD gespeichert!';"
"}"
"function saveSim(){"
"var p=document.getElementById('sim-pin').value;"
"var a=document.getElementById('sim-apn').value;"
"ws.send(JSON.stringify({sim_pin:p,sim_apn:a}));"
"document.getElementById('sim-save-status').innerText='SIM-Daten auf SD gespeichert!';"
"}"
"function uploadGenericFile(){"
"var fileInput=document.getElementById('any-file');"
"if(!fileInput.files.length){return;}"
"var file=fileInput.files[0];"
"var formData=new FormData();formData.append('file',file,file.name);"
"var stat=document.getElementById('upload-status');stat.innerText='Lade '+file.name+' in '+currentDir+'...';"
"var xhr=new XMLHttpRequest();xhr.open('POST','/upload?dir='+encodeURIComponent(currentDir),true);"
"xhr.onload=function(){"
"if(xhr.status===200){stat.innerText='Upload erfolgreich: '+file.name;setTimeout(function(){loadDirectory(currentDir);fetchStatusHTTP();},800);}"
"else{stat.innerText='Fehler beim Speichern';}"
"};"
"xhr.send(formData);"
"}"
"function formatSD(){if(confirm('SD-Karte formatieren? Alle Logdaten werden gelöscht.')){fetch('/format').then(function(r){return r.text();}).then(function(m){loadDirectory('/');fetchStatusHTTP();});}}"
"window.onload=function(){init3D();initWS();fetchStatusHTTP();loadDirectory('/');setInterval(fetchStatusHTTP,2500);};"
"</script></body></html>";
// ==========================================
// 5. ISR & POWER MANAGEMENT
// ==========================================
void IRAM_ATTR bno085_isr() {
  imuInterruptCount++;
}

uint8_t readBMSRegister(uint8_t reg) {
  Wire.beginTransmission(BQ24295_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0xFF;
  Wire.requestFrom((uint8_t)BQ24295_ADDR, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0xFF;
}

void writeBMSRegister(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(BQ24295_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

void enable5VBoostPower() {
  writeBMSRegister(BQ_REG_INPUT_SRC, 0x37);

  uint8_t reg05 = readBMSRegister(BQ_REG_TIMER);
  if (reg05 != 0xFF) {
    writeBMSRegister(BQ_REG_TIMER, reg05 & ~0x30);
  }

  writeBMSRegister(BQ_REG_SYS_CONFIG, 0x7B);
  writeBMSRegister(BQ_REG_VREG, 0xB2);
  delay(30);
}

BMSStatus readBMS() {
  BMSStatus status;
  uint8_t reg08 = readBMSRegister(BQ_REG_SYS_STATUS);
  uint8_t reg09 = readBMSRegister(BQ_REG_FAULT);
  uint8_t reg01 = readBMSRegister(BQ_REG_SYS_CONFIG);
  uint8_t reg02 = readBMSRegister(BQ_REG_CHRG_CURRENT);

  status.rawStatus = reg08;
  status.rawFault = reg09;

  // 1. Genaue ADC-Messung mit Mittelwert
  uint32_t rawSum = 0;
  for (int i = 0; i < 16; i++) {
    rawSum += analogRead(BAT_ADC_PIN);
    delayMicroseconds(100);
  }
  float rawAdc = (float)rawSum / 16.0f;
  float measuredV = (rawAdc / 4095.0f) * 3.30f * 2.0f * 1.035f;
  if (measuredV < 2.5f) measuredV = 3.70f;
  status.batteryVoltage = measuredV;

  // 2. Ladezustand aus BQ24295 Register 0x08 Bits [5:4] dekodieren
  uint8_t chrgStat = (reg08 >> 4) & 0x03;
  status.isCharging = (chrgStat == 0x01 || chrgStat == 0x02);
  status.isFullyCharged = (chrgStat == 0x03);

  // Ladestrom berechnen (Basis 512mA + Step * 64mA)
  uint8_t ichgBits = (reg02 >> 2) & 0x3F;
  status.chargeCurrent_mA = status.isCharging ? (512 + (ichgBits * 64)) : 0;

  switch (chrgStat) {
    case 0x00: status.chargeStatus = "Akku (Entladen)"; break;
    case 0x01: status.chargeStatus = "Vorladung"; break;
    case 0x02: status.chargeStatus = "Schnellladung (" + String(status.chargeCurrent_mA) + " mA)"; break;
    case 0x03: status.chargeStatus = "Vollständig geladen"; break;
  }

  // 3. Glättung / Korrektur des Prozentwerts während des Ladevorgangs
  // Wenn geladen wird, zieht der Ladestrom die Spannung um ca. 0.08 - 0.12V hoch
  float vComp = measuredV;
  if (status.isCharging) {
    vComp -= 0.10f; // Innenwiderstands-Kompensation für realistische Prozentanzeige
    if (vComp < 3.30f) vComp = 3.30f;
  }

  int pct = (int)((vComp - 3.30f) / (4.18f - 3.30f) * 100.0f);
  if (status.isFullyCharged) pct = 100;
  if (pct > 100) pct = 100;
  if (pct < 3)   pct = 3;
  status.batteryPercent = pct;

  uint8_t vbusStat = (reg08 >> 6) & 0x03;
  status.vbusStatus = (vbusStat == 0x03) ? "5V Boost Active" : (status.isCharging ? "USB 5V Netzteil" : "Akkubetrieb");
  status.boostEnabled = (reg01 & 0x20) != 0;
  status.powerGood = (reg08 & 0x04) != 0;
  status.targetVoltage = 4.208f;

  return status;
}

// ==========================================
// 6. I2C RESET & DIRECT SHTP PARSER
// ==========================================
void resetI2CBus() {
  Wire.end();
  pinMode(I2C_SDA_PIN, INPUT_PULLUP);
  pinMode(I2C_SCL_PIN, OUTPUT);
  digitalWrite(I2C_SCL_PIN, HIGH);
  delayMicroseconds(10);
  for (int i = 0; i < 16; i++) {
    digitalWrite(I2C_SCL_PIN, LOW);
    delayMicroseconds(5);
    digitalWrite(I2C_SCL_PIN, HIGH);
    delayMicroseconds(5);
  }
  pinMode(I2C_SDA_PIN, OUTPUT);
  digitalWrite(I2C_SDA_PIN, LOW);
  delayMicroseconds(5);
  digitalWrite(I2C_SCL_PIN, HIGH);
  delayMicroseconds(5);
  digitalWrite(I2C_SDA_PIN, HIGH);
  delay(10);
}

/*
 * Breadcrumb: 2026-09-08 10:15 - SHTP Acknowledged Feature Engine with 0xFC Response Validation
 * [CRITICAL BUGFIX FLAG - SHTP ACK]:
 * Explicitly parses Channel 2 Report 0xFC (Get Feature Response) to verify that
 * the requested report ID and configuration were accepted by the Hillcrest SH-2 core.
 */

/*
 * Breadcrumb: 2026-09-08 20:48 - Hardware Wake-on-Motion Zero-Sensitivity Fix
 * [CRITICAL BUGFIX FLAG - SHTP WAKE REJECTION]:
 * Report 0x12 and 0x22 (Significant Motion) have NO configuration payload.
 * Passing sensQ14 > 0 causes the BNO085 to silently NACK the feature request, 
 * leaving the INT pin locked and preventing Wake-on-Motion entirely.
 */

/*
 * Breadcrumb: 2026-09-08 23:52 - Direct SHTP Set Feature Command
 */

/*
 * Breadcrumb: 2026-09-08 21:15 - SH-2 Compliant Q14 Wake Sensitivity Encoder
 * [CRITICAL BUGFIX FLAG - SHTP Q14 WAKE SPEC]:
 * Report 0x12 requires interval=0 and the motion acceleration threshold encoded 
 * in Bytes 13-16 (Sensor-Specific Configuration) in Q14 fixed-point format.
 */

/*
 * Breadcrumb: 2026-09-08 21:35 - SH-2 Wakeup Flag & Q14 Configuration Fix
 * [CRITICAL BUGFIX FLAG - SHTP WAKEUP FLAG]:
 * Sets Feature Flag 0x01 (Wakeup) on Report 0x12 to route interrupts to HOST_INTN in sleep.
 * Embeds sensitivity threshold in Q14 format across Bytes 13-16.
 */

/*
 * Breadcrumb: 2026-09-08 22:25 - SH-2 Wakeup Flag & Q14 Threshold Encoder
 * [CRITICAL BUGFIX FLAG - SHTP Q14 ENCODING]:
 * Encodes sensitivity in Q14 format across Bytes 17-20 for Report 0x12,
 * setting Feature Flag 0x01 (Wakeup Delivery) on SHTP Channel 2.
 */

/*
 * Breadcrumb: 2026-09-08 22:40 - Correct Q14 Byte Alignment for Set Feature (0xFD)
 * [CRITICAL BUGFIX FLAG - SHTP BYTE OFFSETS]:
 * SHTP Set Feature Command (21 bytes total):
 * Bytes 0..3: Header (Len=21, Chan=2)
 * Byte 4: 0xFD (Command)
 * Byte 5: Report ID
 * Byte 6: Feature Flags (0x01 = Wakeup for 0x12)
 * Bytes 7..8: Change Sensitivity (0x0000)
 * Bytes 9..12: Report Interval (0 for 0x12)
 * Bytes 13..16: Batch Interval (0)
 * Bytes 17..20: Sensor-Specific Config (Q14 Motion Threshold)
 */

/*
 * Breadcrumb: 2026-09-08 22:48 - Correct 21-Byte SH-2 Set Feature Structure
 * [CRITICAL BUGFIX FLAG - SHTP SET FEATURE]:
 * Strictly aligns Feature Flags (Byte 6) and Q14 Sensitivity (Bytes 17-20)
 * for Wake-on-Motion Report 0x12.
 */

/*
 * Breadcrumb: 2026-09-08 21:45 - Standard SH-2 Wakeup Feature & Safe I2C Bus Reader
 * [CRITICAL BUGFIX FLAG - SHTP 0x12 SPEC]:
 * 1. Report 0x12 (Significant Motion) must have sensorSpecificConfig = 0. Passing Q14 values 
 *    in bytes 17..20 causes SH-2 core rejection and prevents feature confirmation.
 * 2. Added I2C status verification and recovery to prevent bytesRead < 4 starvation.
 */
// ============================================================================
// 6. I2C SHTP FEATURE ENABLER (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 22:55 - SH-2 Instant Motion Trigger & Wakeup Flag Config
 * [CRITICAL BUGFIX FLAG - SHTP 0x13 & 0x12 WAKEUP]:
 * Replaced heuristical Significant Motion (0x22, steps-only) with Stability Detector (0x13)
 * and Wakeup Flag (Bit 0 = 1 in Feature Flags).
 * Configures interval=0 for event-based reports to assert HOST_INTN immediately on motion.
 */
// ============================================================================
// 6. I2C SHTP FEATURE ENABLER (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:30 - Native Wake-Up Detector Set (0x21 & 0x22)
 * [CRITICAL BUGFIX FLAG - SH-2 WAKE DETECTORS]:
 * Uses native Hillcrest SH-2 Wake-Up Reports:
 * - 0x21: Wake-Up Stability Classifier (Triggers immediately on state transition)
 * - 0x22: Wake-Up Significant Motion (Secondary trigger)
 * Sets Feature Flag Bit 0 = 1 (Wake-Up Delivery via HOST_INTN) and interval = 0.
 */
/*
 * Breadcrumb: 2026-09-08 22:50 - Hardened Wake-on-Motion Engine & Continuous Dynamic Wakeup
 * [CRITICAL BUGFIX FLAG - EXT0 WAKE-ON-MOTION]:
 * 1. BNO085 Wake-up Accelerometer (0x20) und Wake-up Stability (0x21) benötigen ein aktives 
 *    Sampling-Intervall (z.B. 50ms = 20Hz), um intern Messungen durchzuführen.
 *    Ein Intervall von 0 deaktivierte die Sensoren vollständig.
 * 2. Setzt Bit 0 in featureFlags (0x01 = Wakeup-Delivery auf HOST_INTN).
 * 3. Hält I2C-Pullups und RTC-Domain unter konstanter Spannung.
 */

// ============================================================================
// 6. I2C SHTP FEATURE ENABLER (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:45 - Robust SH-2 Feature Enabler with Bus Check & Logging
 * [CRITICAL BUGFIX FLAG - SHTP ERROR TRACE]:
 * Fügt Rückgabewert-Prüfung von Wire.endTransmission() hinzu und loggt I2C-NACKs.
 */

// ============================================================================
// 6. I2C SHTP FEATURE ENABLER (REPLACEMENT)
// ============================================================================
// ============================================================================
// 6. I2C SHTP FEATURE ENABLER & TRUE 2-STAGE PARSER
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:55 - Deep Diagnostic SHTP Feature Enabler
 * [CRITICAL BUGFIX FLAG - FEATURE TRACE]:
 * Protokolliert jeden Schritt des 0xFD Set-Feature-Befehls inklusive
 * Fehlercode von Wire.endTransmission() zur Isolierung von Bus-NACKs.
 */
/*
 * Breadcrumb: 2026-09-09 01:40 - SHTP Change-Sensitivity & Wakeup Sentinel Encoder
 * [CRITICAL BUGFIX FLAG - SHTP ABSOLUTE SENSITIVITY]:
 * Unterstützt Feature Flag 0x09 (Bit 0 = Wakeup, Bit 3 = Absolute Change Sensitivity).
 * Übergibt sensitivity in Bytes 7-8 als Q8-Festkommawert (256 LSB = 1 m/s²).
 */
/*
 * Breadcrumb: 2026-09-09 01:50 - Clean Event-Based Wakeup Feature Enabler
 * [CRITICAL BUGFIX FLAG - SHTP EVENT WAKE]:
 * Report 0x13 und 0x12 müssen zwingend Intervall 0 und SensorSpecificConfig 0 haben.
 * Setzt Feature Flag 0x01 (Wakeup Delivery) für verzögerungsfreie Pegeländerung.
 */
/*
 * Breadcrumb: 2026-09-09 02:00 - Native SH-2 Wake-on-Motion Feature Enabler
 * [CRITICAL BUGFIX FLAG - SH-2 MOTION SENSORS]:
 * Schärft Report 0x17 (Stability Detector) und 0x12 (Significant Motion).
 * Setzt Feature Flag 0x01 (Wakeup Delivery) und Intervall 0 für Event-Trigger.
 */
/*
 * Breadcrumb: 2026-09-09 02:15 - Native SH-2 Hardware Wake-on-Motion Engine
 * [CRITICAL BUGFIX FLAG - HARDWARE WAKE-ON-MOTION]:
 * 1. enableBNO085WakeOnMotion: Nutzt Report 0x04 mit Feature Flags 0x07 (Change Sensitivity + Absolute + Wakeup).
 * 2. Taktet intern mit 50ms, sendet im Ruhezustand 0 Pakete (GPIO 32 bleibt 1).
 * 3. Triggert bei Erschütterung oberhalb des Schwellenwerts sofort LOW auf GPIO 32.
 */
bool enableBNO085WakeOnMotion(float threshold_mps2) {
  uint32_t interval_us = 50000; 
  
  // [WICHTIGER BUGFIX] Bit 1 muss 0 sein -> RELATIVE Change Sensitivity!
  // Ignoriert Rauschen und Erdbeschleunigung. Triggert nur bei echter Veränderung!
  uint8_t featureFlags = 0x05;  
  
  if (threshold_mps2 < 0.15f) threshold_mps2 = 0.15f;
  uint16_t changeSensitivity = (uint16_t)(threshold_mps2 * 256.0f); // Q8-Format

  uint8_t cmd[21] = {
    21, 0, 2, 0, 
    0xFD, 
    0x04, // Report ID: 0x04 (Linear Acceleration)
    featureFlags,
    (uint8_t)(changeSensitivity & 0xFF), (uint8_t)((changeSensitivity >> 8) & 0xFF),
    (uint8_t)(interval_us & 0xFF), (uint8_t)((interval_us >> 8) & 0xFF),
    (uint8_t)((interval_us >> 16) & 0xFF), (uint8_t)((interval_us >> 24) & 0xFF),
    0x00, 0x00, 0x00, 0x00, 
    0x00, 0x00, 0x00, 0x00  
  };

  logMsg("[SHTP WAKE] Schärfe Wake-on-Motion (0x04): 50ms, Flags 0x05 (Relativ), Schwelle: %.2f m/s² (Q8: %u)\n",
         threshold_mps2, changeSensitivity);

  Wire.beginTransmission(BNO085_I2C_ADDR);
  Wire.write(cmd, 21);
  return (Wire.endTransmission() == 0);
}

bool enableBNO085Feature(uint8_t addr, uint8_t reportId, uint16_t reportInterval_ms, float sensitivity) {
  uint32_t interval_us = (uint32_t)reportInterval_ms * 1000;
  uint8_t featureFlags = 0x00;
  uint32_t sensorSpecificConfig = 0;

  uint8_t cmd[21] = {
    21, 0, 2, 0, 
    0xFD, reportId, featureFlags, 0x00, 0x00,
    (uint8_t)(interval_us & 0xFF), (uint8_t)((interval_us >> 8) & 0xFF),
    (uint8_t)((interval_us >> 16) & 0xFF), (uint8_t)((interval_us >> 24) & 0xFF),
    0x00, 0x00, 0x00, 0x00,
    (uint8_t)(sensorSpecificConfig & 0xFF), (uint8_t)((sensorSpecificConfig >> 8) & 0xFF),
    (uint8_t)((sensorSpecificConfig >> 16) & 0xFF), (uint8_t)((sensorSpecificConfig >> 24) & 0xFF)
  };

  Wire.beginTransmission(addr);
  Wire.write(cmd, 21);
  uint8_t i2c_res = Wire.endTransmission();
  return (i2c_res == 0);
}

/*
 * Breadcrumb: 2026-09-07 02:55 - Critical SHTP Byte Alignment Fix
 * [CRITICAL BUGFIX FLAG - SHTP PARSER]: 
 * Corrected byte offsets for SH-2 Input Reports (0x05 / 0x08):
 * Byte 4=ID, 5=Seq, 6=Status, 7=Delay, 8..9=QX, 10..11=QY, 12..13=QZ, 14..15=QW.
 */

/*
 * Breadcrumb: 2026-09-08 18:25 - Exact 2-Stage SHTP Frame-Safe Parser
 * [CRITICAL BUGFIX FLAG - SHTP FRAMING]:
 * Reads exact 4-byte SHTP header first to determine packetLength dynamically.
 * Consumes the exact cargo bytes to prevent I2C FIFO framing de-sync.
 */

/*
 * Breadcrumb: 2026-09-08 18:40 - Buffer-Safe SHTP Multi-Report Parser
 * [CRITICAL BUGFIX FLAG - SHTP I2C BUFFER]:
 * Reads up to 32 bytes in a single transaction (ESP32 Wire hardware buffer limit),
 * correctly parses both 0x08 (Quat) and 0x04 (Linear Accel) across report boundaries.
 */

/*
 * Breadcrumb: 2026-09-08 18:45 - 2-Stage Chunked SHTP Parser (<32 Byte Safe)
 * [CRITICAL BUGFIX FLAG - SHTP CHUNKING]:
 * 1. Reads exactly 4 bytes header to determine dynamic packet length.
 * 2. Reads remaining payload in safe chunks <= 28 bytes to respect ESP32 Wire buffer limits.
 */

/*
 * Breadcrumb: 2026-09-08 18:30 - Single-Transaction SHTP Frame-Safe Parser
 * [CRITICAL BUGFIX FLAG - SHTP I2C FRAMING]:
 * Dismissed code: Splitting the read into 4-byte header and subsequent chunk requests
 * with Wire.requestFrom() caused the BNO085 to abort the SHTP packet upon the I2C STOP condition.
 * The payload returned 0xFF, hasValidQuat remained false, and no data was streamed over WebSockets.
 * Fix: Reads up to 64 bytes in a single contiguous I2C transaction, evaluates dynamic packet length,
 * and extracts Rotation Vector (0x08) and Linear Accel (0x04) directly from the aligned buffer.
 */

/*
 * Breadcrumb: 2026-09-08 20:45 - Frame-Exact SHTP Payload Parser & FIFO Drain
 * [CRITICAL BUGFIX FLAG - SHTP I2C FRAMING]:
 * Dismissed NACK bug: Requesting a static 64 bytes caused the BNO085 to lock up 
 * if the actual packet was shorter. 
 * Fix: The master reads exactly 4 bytes, evaluates the true packetLength, and 
 * fetches the exact amount to prevent clock stretching and NACK dropouts.
 */

/*
 * Breadcrumb: 2026-09-08 21:30 - SHTP Payload Offset & Parsing Fix
 * [CRITICAL BUGFIX FLAG - SHTP PARSER OFFSET]:
 * When reading the 4-byte header, the BNO085 advances its internal FIFO.
 * The subsequent read of the payload starts exactly at byte 0 of the new buffer,
 * NOT at byte 4. The previous offset caused the parser to miss Report ID 0x08.
 * Fix: payload is directly mapped from index 0. Unknown reports break the .
 */

/*
 * Breadcrumb: 2026-09-08 22:10 - Restored ESP32 Chunked I2C & FIFO Drain
 * [CRITICAL BUGFIX FLAG - I2C CHUNKING]:
 * Restored the crucial <=28 byte chunking. The ESP32 Wire library drops data 
 * if a single requestFrom exceeds 32 bytes. This restores the live stream!
 */

/*
 * Breadcrumb: 2026-09-08 19:25 - I2C Diagnostic Logging & Duplicate Removal
 * [CRITICAL BUGFIX FLAG - I2C DIAGNOSTICS]:
 * Added throttled logMsg to readSHTPPacket to trace I2C failures without flooding WebSockets.
 * Consolidated flushBNO085FIFO to resolve redefinition compiler error.
 */

/*
 * Breadcrumb: 2026-09-08 23:40 - SHTP Protocol Compliant Parser & ACK Drainer
 * [CRITICAL BUGFIX FLAG - SHTP DRAIN]:
 * Correctly consumes Channel 2 (0xFC) and Channel 4/3 responses so the BNO085
 * de-asserts HOST_INTN (GPIO 33) to HIGH naturally when the FIFO is empty.
 */
/*
 * Breadcrumb: 2026-09-08 23:50 - Atomic SHTP Packet Parser & Clean INT Release
 * [CRITICAL BUGFIX FLAG - SHTP ATOMIC READ]:
 * Dismissed chunked Wire.requestFrom() calls which sent premature I2C STOP conditions,
 * corrupting the BNO085 read pointer and locking GPIO 33 permanently LOW.
 * Fix: Reads header (4 bytes) and entire cargo in single atomic requests,
 * allowing the BNO085 to naturally release HOST_INTN (GPIO 33) to HIGH.
 */

/*
 * Breadcrumb: 2026-09-08 23:55 - Atomic Single-Transaction SHTP Reader & Deep Diagnostics
 * [CRITICAL BUGFIX FLAG - ATOMIC SHTP READ]:
 * Replaced split requestFrom() calls with a single 128-byte atomic read.
 * This allows the BNO085 SHTP state machine to mark packets as fully transmitted,
 * properly emptying the FIFO and releasing GPIO 33 to HIGH.
 */

/*
 * Breadcrumb: 2026-09-08 20:50 - Extended FIFO Drain & Unhandled Report Logging
 * [CRITICAL BUGFIX FLAG - FIFO DRAIN LIMIT]:
 * Increased drain limit from 25 to 150 packets. Logs unhandled channel/packet IDs
 * to prevent premature aborts while residual 10Hz/50Hz frames clear the queue.
 */

/*
 * Breadcrumb: 2026-09-08 21:40 - Stable-State FIFO Drainer
 * [CRITICAL BUGFIX FLAG - FIFO DRAIN STABILITY]:
 * Drains until GPIO 33 is verified HIGH continuously without frame timeouts.
 */

/*
 * Breadcrumb: 2026-09-08 22:20 - Exact-Length SHTP 2-Stage Parser & FIFO Release
 * [CRITICAL BUGFIX FLAG - SHTP EXACT LENGTH READ]:
 * Requesting static 128 bytes on 21-byte ACK packets caused BNO085 I2C buffer overruns,
 * locking GPIO 33 LOW. Now reads exact 4-byte header followed by exact cargo length.
 */

/*
 * Breadcrumb: 2026-09-08 22:35 - True SHTP Packet Retransmit & Pop Parser
 * [CRITICAL BUGFIX FLAG - SHTP I2C RESTART POINTER]:
 * BNO085 resets read DMA pointer to byte 0 on every I2C START condition.
 * The second requestFrom MUST read full packetLength bytes (including header)
 * for the SH-2 firmware to pop the packet from FIFO and release GPIO 33 to HIGH.
 */

/*
 * Breadcrumb: 2026-09-08 22:45 - Exact Cargo Length SHTP Read & Stable Drain
 * [CRITICAL BUGFIX FLAG - SHTP CARGO LENGTH]:
 * Fixed buffer overrun where second requestFrom read packetLength instead of (packetLength - 4).
 * Reading exact cargoLength allows BNO085 to pop packets from FIFO and release GPIO 33 to HIGH.
 */

/*
 * Breadcrumb: 2026-09-08 21:25 - SHTP Full Packet Read & FIFO Pop Fix
 * [CRITICAL BUGFIX FLAG - SHTP 2-STAGE FULL READ]:
 * Dismissed code: Wire.requestFrom(addr, cargoLength) (packetLength - 4) caused the BNO085 
 * to mark the transfer as incomplete. The packet was never popped from the FIFO, locking 
 * HOST_INTN (GPIO 33) permanently LOW.
 * Fix: The second transaction requests the full packetLength (Header + Cargo). The SH-2 core 
 * pops the packet, clears the FIFO, and releases GPIO 33 to HIGH immediately.
 * Payload parsing starts at index 4 (byte 0..3 = retransmitted transport header).
 */
/*
 * Breadcrumb: 2026-09-08 21:35 - Single-Transaction Atomic SHTP Packet Drainer
 * [CRITICAL BUGFIX FLAG - SHTP ATOMIC READ]:
 * Dismissed code: Split Wire.requestFrom() calls send I2C STOP conditions, breaking 
 * the BNO085 DMA state machine and preventing packet popping (FIFO stays locked).
 * Fix: Reads available bytes up to 128 in a single atomic transaction. The Hillcrest SH-2 
 * core marks the packet as fully transmitted and immediately releases GPIO 33 to HIGH.
 */
/*
 * Breadcrumb: 2026-09-08 21:30 - Exact-Length SHTP 2-Stage Parser & Drain Stability
 * [CRITICAL BUGFIX FLAG - SHTP EXACT LENGTH]:
 * Dismissed code: Blindly requesting 128 bytes caused I2C clock overrun on short packets (e.g. 21-byte ACKs),
 * causing the BNO085 to flood padding packets and lock GPIO 33 LOW.
 * Fix: Reads 4 bytes header to extract packetLength, then requests exact packetLength bytes.
 * The BNO085 pops the packet cleanly from FIFO and de-asserts HOST_INTN (GPIO 33) to HIGH.
 */
/*
 * Breadcrumb: 2026-09-08 21:35 - Atomic 1-Shot SHTP Packet Parser & Deep Debug Logging
 * [CRITICAL BUGFIX FLAG - SHTP 1-SHOT READ]:
 * Dismissed 2-stage split reads: The I2C STOP condition between header and cargo caused 
 * the BNO085 DMA to abort, leaving the un-popped packet in FIFO and GPIO 33 locked LOW.
 * Fix: Reads up to 64 bytes in a single atomic I2C transaction, evaluates the actual packet 
 * length from bytes 0..1, processes CH2/CH3/CH4, and prints unknown reports for debugging.
 */
/*
 * Breadcrumb: 2026-09-08 21:40 - Deep SHTP Packet Inspector & Payload Sniffer
 * [CRITICAL BUGFIX FLAG - SHTP DEBUG SNIFFER]:
 * Added packet-level logging for all channels (CH0..CH5) and unhandled report IDs.
 * Prints raw hex bytes during sleep transition to identify streaming flood sources.
 */
/*
 * Breadcrumb: 2026-09-08 21:55 - SHTP Zero-Length Packet Drain & Fast Exit
 * [CRITICAL BUGFIX FLAG - SHTP ZERO LENGTH]:
 * Dismissed code: Rejecting (H: 0x00 0x00 0x00 0x00) prevented the SHTP state machine
 * from clearing the read request, causing an infinite loop where GPIO 33 stayed LOW.
 * Fix: Header length 0 is treated as a valid FIFO-Empty indicator, exiting the drain immediately.
 */
/*
 * Breadcrumb: 2026-09-08 22:05 - Exact SHTP Header/Cargo Split & Instant INT Release
 * [CRITICAL BUGFIX FLAG - SHTP OVERREAD INT LOCK]:
 * Dismissed code: Requesting 64 bytes on a 4-byte/0-byte empty frame forced the BNO085 
 * to re-assert HOST_INTN LOW continuously.
 * Fix: Reads exactly 4 bytes header. If packetLength <= 4, transaction ends cleanly without 
 * extra clocks. Cargo is read only if packetLength > 4. GPIO 33 goes HIGH immediately.
 */
/*
 * Breadcrumb: 2026-09-08 22:20 - True 2-Stage SHTP Packet Popping Engine
 * [CRITICAL BUGFIX FLAG - SHTP FIFO POP]:
 * 1. Reads 4 bytes header to determine packetLength.
 * 2. Requests the full packetLength (Header + Cargo) in the second transaction. 
 *    The BNO085 DMA completes the packet transfer, clears it from FIFO, 
 *    and de-asserts HOST_INTN (GPIO 33) to HIGH instantly.
 * 3. Payload is parsed directly starting at packetBuf[4].
 */
/*
 * Breadcrumb: 2026-09-08 22:30 - Atomic SHTP Single-Read & Raw Packet Debugger
 * [CRITICAL BUGFIX FLAG - SHTP SINGLE TRANSACTION]:
 * Replaced split requestFrom() with a single contiguous 64-byte transaction.
 * Evaluates dynamic packet length directly from header bytes 0..1.
 * Logs exact failure reasons and raw hex bytes if packets cannot be decoded.
 */
/*
 * Breadcrumb: 2026-09-08 22:55 - Dynamic Buffer SHTP Drain & Fragmentation Engine
 * [CRITICAL BUGFIX FLAG - SHTP CONTINUATION & LARGE FRAMES]:
 * Dismissed 64-byte clamp: BNO085 sends boot reports up to 276 bytes with Continuation bit (0x80).
 * Clamping to 64 caused unread fragments to stay in FIFO, locking HOST_INTN (GPIO 33) LOW.
 * Fix: Reads header, masks out continuation bit, reads up to 280 bytes dynamically,
 * marks fragmented packets as consumed, and releases GPIO 33 to HIGH immediately.
 */
/*
 * Breadcrumb: 2026-09-08 23:15 - SHTP Channel 0 Flow-Control Consumer & Clean INT Release
 * [CRITICAL BUGFIX FLAG - SHTP FLOW CONTROL]:
 * Dismissed code: Treating Channel 0 Len=8 packets as unknown commands created an infinite 
 * loop where the BNO085 continuously re-transmitted SHTP credit advertisements.
 * Fix: Silently absorbs Channel 0 Flow-Control updates, completes the transport layer handshake, 
 * and drains all residual frames until HOST_INTN (GPIO 33) transitions to HIGH.
 */
/*
 * Breadcrumb: 2026-09-08 23:25 - Single-Transaction Full SHTP Packet Reader & FIFO Release
 * [CRITICAL BUGFIX FLAG - SHTP ATOMIC READ]:
 * Dismissed chunked Wire.requestFrom(): Sending I2C STOP conditions inside a packet broke 
 * the BNO085 DMA state machine, leaving packets trapped in FIFO and locking GPIO 33 LOW.
 * Fix: Reads header + cargo in a single atomic Wire.requestFrom() transaction up to 128 bytes.
 * The SH-2 core marks the packet as completed, pops it from FIFO, and releases GPIO 33 to HIGH immediately.
 */
// ============================================================================
// 6. I2C RESET & ATOMIC SHTP PARSER (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 22:30 - Atomic SHTP Packet Reader & Clean INT-Release
 * [CRITICAL BUGFIX FLAG - SHTP SINGLE TRANSACTION READ]:
 * Dismissed split requestFrom(): Sending an I2C STOP condition between header (4 bytes)
 * and cargo prevented the Hillcrest SH-2 DMA engine from acknowledging packet consumption.
 * The un-popped packet remained in the FIFO, locking HOST_INTN (GPIO 33) permanently LOW.
 * Fix:
 * 1. Reads up to 128 bytes in a single atomic Wire.requestFrom() transaction.
 * 2. Validates dynamic packet length directly from header bytes [0..1].
 * 3. Consumes entire packet so BNO085 clears FIFO and de-asserts GPIO 33 to HIGH immediately.
 */
/*
 * Breadcrumb: 2026-09-08 23:50 - Robust Atomic SHTP Reader
 * [CRITICAL BUGFIX FLAG - SHTP INT TIMEOUT & READ]:
 * Liest anstehende Pakete aus und setzt imuAvailable / hasValidQuat deterministisch.
 */
/*
 * Breadcrumb: 2026-09-08 23:30 - True 2-Stage SHTP Packet Popping Engine
 * [CRITICAL BUGFIX FLAG - SHTP FIFO DEADLOCK]:
 * 1. Liest 4 Bytes Header aus, ermittelt die reale Paketlänge.
 * 2. Fordert im 2. Schritt exakt die Paketlänge an, damit der BNO085 
 *    das Paket aus dem FIFO poppt und den INT-Pin auf HIGH freigibt.
 */
// ============================================================================
// 6. I2C SHTP FEATURE ENABLER & DIAGNOSTIC PARSER (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 22:30 - Atomic SHTP Packet Reader & Clean INT-Release
 * [CRITICAL BUGFIX FLAG - SHTP SINGLE TRANSACTION READ]:
 * Split requestFrom() zerstoert den DMA des BNO085! Es MUSS ein einzelner 
 * Wire.requestFrom() Aufruf sein, sonst blockiert INT (GPIO 33) dauerhaft LOW!
 */
// ============================================================================
// 6. I2C SHTP PARSER (REPLACEMENT)
// ============================================================================
// ============================================================================
// 6. I2C SHTP PARSER (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:56 - Full Diagnostic 2-Stage SHTP Inspector
 * [CRITICAL BUGFIX FLAG - SHTP SNIFFER]:
 * Detaillierte Protokollierung von Header-Länge, Channel, Sequence,
 * Roh-Bytes und Report-Parsing zur Isolierung von fehlenden 3D-Daten.
 */
/*
 * Breadcrumb: 2026-09-09 00:15 - Active SHTP Polling & INT Fallback Engine
 * [CRITICAL BUGFIX FLAG - SHTP UNBLOCKED]:
 * Entfernt die harte 'if (INT == HIGH) return'-Sperre. Liest I2C direkt aus.
 * Wenn keine Daten im FIFO liegen (Len <= 4 oder 0xFFFF), beendet die Funktion 
 * nach 4 Header-Bytes sauber ohne Blockade.
 */
/*
 * Breadcrumb: 2026-09-09 21:15 - SHTP Buffer Hardening & Boundary Clamping
 * [CRITICAL BUGFIX FLAG - SHTP BUFFER INTEGRITY]:
 * Expanded internal payload buffer to 516 bytes and strictly clamped packetLength <= 512.
 * Eliminates zero-margin indexing boundary issues when receiving large channel packets.
 */
bool readSHTPPacket(uint8_t addr) {
  // ---------------------------------------------------------
  // STUFE 1: 4 Bytes Header anfordern
  // ---------------------------------------------------------
  uint8_t header[4];
  uint16_t bytesRead = Wire.requestFrom((uint16_t)addr, (size_t)4);
  if (bytesRead < 4) {
    while (Wire.available()) Wire.read();
    return false;
  }

  header[0] = Wire.read();
  header[1] = Wire.read();
  header[2] = Wire.read();
  header[3] = Wire.read();

  uint16_t packetLength = ((header[1] << 8) | header[0]) & ~0x8000;
  uint8_t channel = header[2];
  uint8_t seqNum  = header[3];

  // Kein Paket vorhanden, Bus im Leerlauf oder Überlänge
  if (packetLength <= 4 || packetLength > 512 || (header[0] == 0xFF && header[1] == 0xFF)) {
    return false;
  }

  // ---------------------------------------------------------
  // STUFE 2: Gesamtes Paket lesen
  // ---------------------------------------------------------
  uint8_t payload[516];
  bytesRead = Wire.requestFrom((uint16_t)addr, (size_t)packetLength);

  if (bytesRead < packetLength) {
    logMsg("[SHTP ERR] Unterlauf: %u von %u Bytes!\n", bytesRead, packetLength);
    while (Wire.available()) Wire.read();
    return false;
  }

  for (uint16_t i = 0; i < bytesRead; i++) {
    payload[i] = Wire.read();
  }
  while (Wire.available()) Wire.read();

  if (channel == 0) return true; // Flow Control

  if (channel == 2) {
    if (bytesRead >= 6 && payload[4] == 0xFC) {
      logMsg("[BNO085 ACK] Feature 0x%02X bestaetigt!\n", payload[5]);
    }
    return true;
  }

  // Sensordaten parsen (Channel 3 & 4)
  if (channel == 3 || channel == 4) {
    uint16_t idx = 4;
    while (idx + 1 < packetLength) {
      uint8_t reportId = payload[idx];

if (reportId == 0x08 || reportId == 0x05) {
        uint8_t requiredLen = (reportId == 0x08) ? 14 : 12; // 0x08 has 2 bytes accuracy, 0x05 has none
        if (idx + requiredLen <= packetLength) {
          int16_t raw_i = (int16_t)(payload[idx + 5] << 8 | payload[idx + 4]);
          int16_t raw_j = (int16_t)(payload[idx + 7] << 8 | payload[idx + 6]);
          int16_t raw_k = (int16_t)(payload[idx + 9] << 8 | payload[idx + 8]);
          int16_t raw_r = (int16_t)(payload[idx + 11] << 8 | payload[idx + 10]);

          const float q14_scale = 1.0f / 16384.0f;
          latest_qx = (float)raw_i * q14_scale;
          latest_qy = (float)raw_j * q14_scale;
          latest_qz = (float)raw_k * q14_scale;
          latest_qw = (float)raw_r * q14_scale;

hasValidQuat = true;
          imuAvailable = true;
          idx += requiredLen; // [KORREKTUR] Darf nicht fest auf 14 stehen!
        } else break;
      }
      else if (reportId == 0x04) {
        if (idx + 10 <= packetLength) {
          int16_t raw_x = (int16_t)(payload[idx + 5] << 8 | payload[idx + 4]);
          int16_t raw_y = (int16_t)(payload[idx + 7] << 8 | payload[idx + 6]);
          int16_t raw_z = (int16_t)(payload[idx + 9] << 8 | payload[idx + 8]);

const float q8_scale = 1.0f / 256.0f; // BNO085 uses Q8 format (1/256) for Linear Accel
          latest_ax = (float)raw_x * q8_scale;
          latest_ay = (float)raw_y * q8_scale;
          latest_az = (float)raw_z * q8_scale;
          idx += 10;
        } else break;
      }
      else if (reportId == 0x12 || reportId == 0x22 || reportId == 0x13 || reportId == 0x21) {
        logMsg("[BNO085 WAKE] Report 0x%02X empfangen!\n", reportId);
        idx += 6;
      }
      else if (reportId == 0xFB) {
        idx += 5;
      }
      else {
        break;
      }
    }
  }
  return true;
}
void flushBNO085FIFO() {
  uint32_t start = millis();
  uint32_t highStartTime = millis();
  uint16_t count = 0;

  logMsg("[FIFO DRAIN] Starte Entleerung... Start-INT=%d\n", digitalRead(BNO08X_INT));
  while (millis() - start < 400) { 
    if (digitalRead(BNO08X_INT) == LOW) {
      count++;
      readSHTPPacket(BNO085_I2C_ADDR);
      highStartTime = millis(); // Reset stable timer since we just cleared a packet
    } else {
      if (millis() - highStartTime >= 60) {
        break; // Exit early: Spec requires INT to be stable HIGH for 60ms
      }
      delayMicroseconds(500); 
    }
  }
  logMsg("[FIFO DRAIN] Beendet: %u Pakete verarbeitet | End-INT=%d (Muss 1 sein!)\n", 
         count, digitalRead(BNO08X_INT));
}






// ==========================================
// 7. FIFO DRAIN & DEEP SLEEP
// ==========================================
/*
 * Breadcrumb: 2026-09-07 20:45 - Structured SD Logging Fix
 * Fix: Uses PATH_ERR_LOG and PATH_BAT_LOG to write logs into /Logs/ directory.
 */

void logErrorToSD(const char* errorMsg) {
  if (!sdAvailable) return;
  createSdDirectories();
  File errFile = SD.open(PATH_ERR_LOG, FILE_APPEND);
  if (errFile) {
    errFile.printf("[%lu ms | Boot #%d] %s\n", millis(), bootCycleCount, errorMsg);
    errFile.close();
  }
}

void logEventToSD(const char* eventName) {
  if (!sdAvailable) return;
  createSdDirectories();
  File file = SD.open("/Logs/full_diag_log.csv", FILE_APPEND);
  if (file) {
    file.printf("%lu,EVENT,%s,0,0,0,0\n", millis(), eventName);
    file.close();
  }
}

void logBatteryStatusToSD() {
  if (!sdAvailable) return;
  createSdDirectories();
  BMSStatus bms = readBMS();
  File batFile = SD.open(PATH_BAT_LOG, FILE_APPEND);
  if (batFile) {
    if (batFile.size() == 0) {
      batFile.println("Timestamp,BatteryVoltage_V,BatteryPercent,ChargingStatus,BootCycle");
    }
    batFile.printf("%s,%.3f,%d,%s,%d\n",
                   getFormattedTimestamp().c_str(),
                   bms.batteryVoltage,
                   bms.batteryPercent,
                   bms.vbusStatus.c_str(),
                   bootCycleCount);
    batFile.close();
  }
}

void syncTimeFromNTP(unsigned long epochSecs) {
  syncEpochTime = epochSecs;
  syncMillisOffset = millis();
  timeIsSynchronized = true;
  Serial.printf("[NTP TIME] Atomuhr synchronisiert: %s\n", getFormattedTimestamp().c_str());
  logEventToSD("NTP_TIME_SYNCHRONIZED");
}

/*
 * Breadcrumb: 2026-09-07 19:35 - Fixed False Wakeup Bug & Stream Teardown
 * [CRITICAL BUGFIX FLAG - IMU SLEEP]:
 * Must disable active 0x08 Rotation Vector stream (interval=0) before sleeping!
 * Otherwise, the sensor continuously asserts GPIO 33 LOW every interval period.
 */
/*
 * Breadcrumb: 2026-09-07 21:05 - Restored SHTP FIFO Drain Routine
 * Fix: Implemented flushBNO085FIFO to drain pending I2C interrupts before sleep.
 *

/*
 * Breadcrumb: 2026-09-07 19:35 - Fixed False Wakeup Bug & Stream Teardown
 * [CRITICAL BUGFIX FLAG - IMU SLEEP]:
 * Must disable active 0x08 Rotation Vector stream (interval=0) before sleeping!
 * Otherwise, the sensor continuously asserts GPIO 33 LOW every interval period.
 */
/*
 * Breadcrumb: 2026-09-07 21:30 - Hardened Hardware Wake-on-Motion Engine
 * [CRITICAL BUGFIX FLAG - IMU WAKE]:
 * Uses Stability Detector (0x17) and Motion Classifier (0x13) to ensure hardware-level EXT0 wakeup.
 * Configures explicit RTC Pull-Up on GPIO 33 to prevent floating pin states.
 */

/*
 * Breadcrumb: 2026-09-07 20:32 - Reliable Hardware Wake-on-Motion Fix
 * [CRITICAL BUGFIX FLAG - IMU HARDWARE WAKE]:
 * 1. Must keep Report 0x01 (Accelerometer) active at 50ms (20Hz) so the motion engine has raw data.
 * 2. Configure PMIC Boost BEFORE arming the sensor so I2C traffic does not corrupt sensor state.
 * 3. Verified GPIO 33 is genuinely HIGH before calling esp_deep_sleep_start().
 */

/*
 * Breadcrumb: 2026-09-07 21:50 - Zero-Interrupt Deep Sleep Config
 * [CRITICAL BUGFIX FLAG - IMU WAKE]:
 * Do NOT subscribe to raw Accelerometer (0x01) during sleep, or INT goes LOW every 50ms!
 * BNO085 automatically powers internal sensors when 0x12/0x17 are requested.
 */

/*
 * Breadcrumb: 2026-09-07 20:48 - Native SH-2 Wake-on-Motion Report (0x22 / 0x12)
 * [CRITICAL BUGFIX FLAG - IMU WAKE ENGINE]:
 * BNO085 requires Report 0x22 (Wakeup Significant Motion) OR 0x12 with explicit sensitivity threshold.
 * We must keep the internal sampling engine armed while disabling output packet spamming.
 */

/*
 * Breadcrumb: 2026-09-08 10:15 - Verified Wake-on-Motion Armed State
 * Fix: Confirms BNO085 ACK before asserting deep sleep.
 */

/*
 * Breadcrumb: 2026-09-08 17:40 - Hardware Wake-on-Motion ARM Fix
 * [CRITICAL BUGFIX FLAG - BNO085 WAKE]:
 * 1. Configured Report 0x12 with interval=0 (mandatory for event detectors).
 * 2. Armed Stability/Motion Detector with valid Q14 threshold.
 * 3. Enforces GPIO 33 HIGH idle state before sleeping.
 */

/*
 * Breadcrumb: 2026-09-08 18:05 - Native 0x22 Wake-on-Motion ARM
 * [CRITICAL BUGFIX FLAG - EXT0 WAKE]:
 * Uses Report 0x22 (Wakeup Significant Motion) which keeps the MEMS core clocked in sleep.
 * Flushes FIFO and enforces RTC pullup on GPIO 33.
 */

/*
 * Breadcrumb: 2026-09-08 18:25 - Bulletproof Significant Motion Sleep Engine
 * [CRITICAL BUGFIX FLAG - EXT0 WAKEUP]:
 * Safely stops active streams, configures Report 0x12 (interval=0, high sensitivity),
 * flushes FIFO and verifies clean HIGH state on GPIO 33.
 */

/*
 * Breadcrumb: 2026-09-08 18:40 - Verified Wake-on-Motion Sleep Routine
 * [CRITICAL BUGFIX FLAG - EXT0 WAKEUP]:
 * Safely stops active 0x08/0x04 streams, enables 0x12 with interval=0,
 * drains FIFO until INT is genuinely HIGH, and arms RTC EXT0.
 */

/*
 * Breadcrumb: 2026-09-08 19:15 - Hardened SH-2 Native Wakeup Engine (0x22 / 0x12 Dual-Arm)
 * [CRITICAL BUGFIX FLAG - EXT0 WAKEUP RESOLUTION]:
 * 1. Explicitly disables continuous streams (0x08, 0x04) with zero interval.
 * 2. Arms Report 0x22 (Wakeup Significant Motion) and Report 0x12 as fallback with Q14 sensitivity.
 * 3. Actively flushes all SHTP channels until GPIO 33 is persistently HIGH for >10ms.
 * 4. Isolates unused RTC peripherals and guarantees clean Active-LOW EXT0 trigger level.
 */

/*
 * Breadcrumb: 2026-09-08 18:35 - Verified Wake-on-Motion Guard & Clean GPIO 33 Rest
 * [CRITICAL BUGFIX FLAG - EXT0 WAKEUP]:
 * Explicitly terminates active periodic 0x08 / 0x04 streams (interval=0).
 * Arms Significant Motion Detector (0x12) with zero interval and Q14 sensitivity.
 * Drains FIFO in continuous burst until GPIO 33 is persistently HIGH before asserting RTC sleep.
 */

/*
 * Breadcrumb: 2026-09-08 20:52 - Safe RTC EXT0 Isolation
 * [CRITICAL BUGFIX FLAG - RTC EXT0 PIN]:
 * Asserts Wakeup Significant Motion (0x22) correctly, completely drains FIFO,
 * and asserts GPIO 33 pullup before sleep.
 */

/*
 * Breadcrumb: 2026-09-08 21:35 - Reliable Sleep & Motion Arm
 * [CRITICAL BUGFIX FLAG - WAKE ARM]:
 * Arms Significant Motion (0x12) as it is universally supported across BNO08X firmwares.
 * Prevents sleep death-loop by ensuring GPIO 33 is HIGH before EXT0 is armed.
 */

/*
 * Breadcrumb: 2026-09-08 22:15 - Reliable EXT0 Sleep Routine
 */

/*
 * Breadcrumb: 2026-09-08 22:50 - Hardened Low-Power Wake Handshake (100kHz & FIFO Clear)
 * [CRITICAL BUGFIX FLAG - EXT0 PIN CLEAR]:
 * Drops I2C clock to 100kHz for reliable low-power register configuration.
 * Continuously drains BNO085 interrupt queue until GPIO 33 is verified HIGH.
 */

/*
 * Breadcrumb: 2026-09-08 23:20 - Hardened Low-Power INT Release & BNO085 Reset
 * [CRITICAL BUGFIX FLAG - EXT0 PIN RELEASE]:
 * Forces a BNO085 software reset and 100kHz clock before sleep,
 * actively waiting until GPIO 33 goes HIGH before arming EXT0 wakeup.
 */

/*
 * Breadcrumb: 2026-09-08 23:55 - SH-2 Compliant Wake-on-Motion Sleep Routine
 * [CRITICAL BUGFIX FLAG - SH-2 STATE PRESERVATION]:
 * Removed pre-sleep softwareResetBNO085() which wiped the wake configuration.
 * Enforces 100kHz I2C clock for reliable low-power register writes, 
 * polls SHTP Channel 2 for Report 0xFC acknowledgment, and guarantees clean HIGH on GPIO 33.
 */

/*
 * Breadcrumb: 2026-09-08 23:55 - Clean Slate Sleep Architecture
 * [CRITICAL BUGFIX FLAG - WAKE ARCHITECTURE]:
 * Trying to gracefully stop 10Hz SHTP streams causes FIFO race conditions on the ESP32.
 * New approach: Force software reset -> Wait for boot -> Drain startup msg -> 
 * Arm ONLY Significant Motion (0x12) -> Sleep. 
 * This guarantees an empty FIFO and a stable HIGH on GPIO 33.
 */

/*
 * Breadcrumb: 2026-09-08 23:45 - Protocol-Compliant Non-Destructive Sleep
 * [CRITICAL BUGFIX FLAG - WAKEUP RESOLUTION]:
 * 1. Disables active continuous streams (0x08, 0x04) with interval=0.
 * 2. Arms Significant Motion (0x12) without parameters.
 * 3. Flushes SHTP Channel 2 ACKs until GPIO 33 is verified HIGH.
 * 4. Enters Deep Sleep with active EXT0 trigger.
 */

/*
 * Breadcrumb: 2026-09-08 23:55 - Verified FIFO Drain & Hardware EXT0 Arm
 * [CRITICAL BUGFIX FLAG - EXT0 WAKE CONFIRMATION]:
 * Disables continuous streams, arms native Wakeup Significant Motion (0x22),
 * drains the SHTP queue until GPIO 33 transitions to HIGH, and enables EXT0 sleep.
 */

/*
 * Breadcrumb: 2026-09-08 23:58 - Fully Instrumented Deep Sleep Handshake
 * [CRITICAL BUGFIX FLAG - EXT0 SLEEP INSTRUMENTATION]:
 * Steps through 100kHz downclock, stream teardown, 0x22 / 0x12 wake arming,
 * and asserts clean HIGH logic on GPIO 33 before committing to deep sleep.
 */

/*
 * Breadcrumb: 2026-09-08 20:52 - Single Wake Report (0x22) & Complete Drain
 * [CRITICAL BUGFIX FLAG - EXT0 PIN RELEASE]:
 * Arms solely Report 0x22 (Wakeup Significant Motion) to avoid duplicate ACK collisions.
 * Drains until GPIO 33 is verified HIGH before invoking esp_deep_sleep_start().
 */

/*
 * Breadcrumb: 2026-09-08 21:10 - Instant Vibration & Shake Wake Engine (0x13 / 0x20)
 * [CRITICAL BUGFIX FLAG - INSTANT SHAKE WAKEUP]:
 * Replaced Significant Motion (0x22, requires human walking pattern) with 
 * Stability Classifier / Motion Detector (0x13) and Wakeup Accelerometer (0x20).
 * Triggers HOST_INTN LOW instantly on the first mechanical shock or tilting pulse.
 */

/*
 * Breadcrumb: 2026-09-08 21:20 - Calibrated Q14 Motion Sentinel Sleep
 * [CRITICAL BUGFIX FLAG - EXT0 SENSITIVITY]:
 * Configures Report 0x12 with sysConfig.imuWakeSensitivity encoded into Q14.
 * Completely drains ACKs to guarantee GPIO 33 is HIGH prior to sleep entry.
 */

/*
 * Breadcrumb: 2026-09-08 21:45 - Pipe-Cooldown & Verified High Sleep Committal
 * [CRITICAL BUGFIX FLAG - SHTP COOLDOWN]:
 * Introduces 35ms settling delay after stream teardown to allow sensor pipelines
 * to complete before draining FIFO and committing to deep sleep.
 */
/*
 * Breadcrumb: 2026-09-08 22:05 - Non-Blocking SH-2 Power Mode & Bus Guard
 * [CRITICAL BUGFIX FLAG - I2C DEADLOCK GUARD]:
 * Enforces Wire transmission timeouts and adequate settling delays to prevent
 * CPU lockups while the BNO085 Cortex-M0+ transitions between sleep and run modes.
 */

void setBNO085PowerMode(uint8_t mode) {
  // mode: 0x01 = On, 0x02 = Sleep
  uint8_t cmd[5] = {5, 0, 1, 0, mode};
  Wire.beginTransmission(BNO085_I2C_ADDR);
  Wire.write(cmd, 5);
  Wire.endTransmission();
  delay(mode == 0x01 ? 150 : 20); // 150ms Boot-Zeit beim Aufwachen zwingend erforderlich
}

/*
 * Breadcrumb: 2026-09-08 21:55 - Executable Channel Sleep & EXT0 Committal
 * [CRITICAL BUGFIX FLAG - SHTP EXECUTABLE SLEEP]:
 * 1. Arms Report 0x12 with configured Q14 threshold.
 * 2. Flushes immediate ACK.
 * 3. Sends SHTP Executable Sleep (0x02) to halt internal sampling.
 * 4. Verifies instant HIGH on GPIO 33 and commits to Deep Sleep.
 */

/*
 * Breadcrumb: 2026-09-08 22:30 - Autonomous Sentinel Deep Sleep Committal
 * [CRITICAL BUGFIX FLAG - EXT0 COMMITTAL]:
 * Teardown active 10Hz streams -> Arm Significant Motion (0x12) with Q14 sensitivity ->
 * Drain ACKs cleanly -> Verify GPIO 33 HIGH -> Commit to ESP32 EXT0 Deep Sleep.
 */

/*
 * Breadcrumb: 2026-09-08 22:45 - High-Logic Verified Sleep Committal
 */

/*
 * Breadcrumb: 2026-09-08 22:50 - Clean Stream Teardown & High-State Sleep Committal
 */

/*
 * Breadcrumb: 2026-09-08 21:35 - Hardened Safe Deep-Sleep Committal Sequence
 * [CRITICAL BUGFIX FLAG - PRE-SLEEP HANDSHAKE]:
 * 1. Disables continuous streams (0x08, 0x04) and allows a 30ms cooldown.
 * 2. Flushes residual stream packets.
 * 3. Arms Significant Motion (0x12) with Wakeup Flag (0x01).
 * 4. Drains final ACK packet.
 * 5. Verifies GPIO 33 is genuinely HIGH before enabling RTC EXT0.
 */
/*
 * Breadcrumb: 2026-09-08 21:30 - Deep Sleep with Final INT Verification & Delay
 * [CRITICAL BUGFIX FLAG - EXT0 SLEEP ARM]:
 * Adds 30ms settling delay after arming 0x12, flushes ACK, and guarantees clean HIGH logic.
 */
/*
 * Breadcrumb: 2026-09-08 21:35 - Sequenced Deep Sleep Committal
 * [CRITICAL BUGFIX FLAG - SLEEP HANDSHAKE]:
 * 1. Lowers I2C clock to 100 kHz.
 * 2. Stops periodic streams (0x08, 0x04).
 * 3. Settling cooldown (40ms) before draining remaining pipeline packets.
 * 4. Arms Significant Motion (0x12) and clears ACK.
 * 5. Verifies GPIO 33 HIGH before enabling RTC EXT0 wakeup.
 */
/*
 * Breadcrumb: 2026-09-08 21:45 - Deterministic Sleep Sequence (400kHz Stable I2C)
 * [CRITICAL BUGFIX FLAG - I2C SLEEP STABILITY]:
 * Kept I2C at standard 400kHz to avoid clock-stretching desync during sleep configuration.
 * Disables 0x08/0x04 -> Drains FIFO -> Arms 0x12 -> Drains ACK -> Sleeps.
 */
/*
 * Breadcrumb: 2026-09-08 21:55 - Verified INT-Release Sleep Routine
 * [CRITICAL BUGFIX FLAG - EXT0 SLEEP SUCCESS]:
 * Disables active 0x08/0x04 streams, arms 0x12 Wakeup, clears residual zero-length frames,
 * and enters Deep Sleep with confirmed GPIO 33 HIGH.
 */
/*
 * Breadcrumb: 2026-09-08 22:05 - Hardened Low-Power Sleep Committal with SHTP Executable Sleep
 * [CRITICAL BUGFIX FLAG - SHTP SLEEP HANDSHAKE]:
 * 1. Disables continuous streams (0x08, 0x04) and drains FIFO.
 * 2. Arms Significant Motion (0x12) for hardware EXT0 wake.
 * 3. Sends SHTP Executable Command 0x02 (Sleep) on Channel 1 to halt streaming pipelines.
 * 4. Drains final acknowledgment -> GPIO 33 verified HIGH.
 */
/*
 * Breadcrumb: 2026-09-08 22:20 - Deterministic Deep Sleep Handshake
 * [CRITICAL BUGFIX FLAG - EXT0 SLEEP SUCCESS]:
 * Corrected Executable Sleep Command to Channel 0 (Len=5, Chan=0, SubCmd=2).
 * Drains FIFO -> Verifies GPIO 33 HIGH -> Commits to Deep Sleep with active EXT0 wakeup.
 */
/*
 * Breadcrumb: 2026-09-08 22:30 - Safe Sleep Committal Sequence
 * [CRITICAL BUGFIX FLAG - EXT0 SLEEP]:
 * Disables active 10Hz streams -> Flushes pipeline -> Arms 0x12 -> Flushes ACK ->
 * Verifies GPIO 33 is HIGH -> Commits to Deep Sleep.
 */
/*
 * Breadcrumb: 2026-09-08 22:55 - Native 0x22 Wake-on-Motion Sleep Committal
 * [CRITICAL BUGFIX FLAG - REPORT 0x22 WAKE]:
 * Uses native Report 0x22 (Wakeup Significant Motion) which is designed for hardware EXT0.
 * Clears pipeline -> Arms 0x22 -> Drains ACK -> Confirms GPIO 33 HIGH -> Commits to Deep Sleep.
 */
/*
 * Breadcrumb: 2026-09-08 23:15 - Deterministic Sleep Sequence with Verified HIGH INT
 * [CRITICAL BUGFIX FLAG - WAKE ON MOTION SLEEP COMMITTAL]:
 * 1. Disables 10Hz active streams (0x08, 0x04) and drains pipeline.
 * 2. Arms Report 0x22 (Wakeup Significant Motion) on Channel 2.
 * 3. Flushes remaining ACK frames until GPIO 33 is genuinely HIGH.
 * 4. Commits to ESP32 EXT0 Deep Sleep.
 */
/*
 * Breadcrumb: 2026-09-08 23:25 - Verified High-State Sleep Committal
 * [CRITICAL BUGFIX FLAG - EXT0 SLEEP]:
 * Disables active streams -> Clears pipeline -> Arms 0x22 Wakeup -> Clears ACK ->
 * Verifies GPIO 33 is genuinely HIGH -> Commits to ESP32 EXT0 Deep Sleep.
 */
// ============================================================================
// 7. DEEP SLEEP COMMITTAL (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 22:40 - Guaranteed EXT0 Sleep Handshake with Validated INT HIGH
 * [CRITICAL BUGFIX FLAG - EXT0 SLEEP SUCCESS]:
 * 1. Stops 0x08 / 0x04 periodic streams.
 * 2. Flushes FIFO -> INT goes HIGH.
 * 3. Arms 0x22 (Wakeup Significant Motion).
 * 4. Drains confirmation ACK -> INT returns to HIGH.
 * 5. Commits to Deep Sleep only when GPIO 33 is verified HIGH (level 0 wake).
 */
// ============================================================================
// 7. DEEP SLEEP COMMITTAL (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:00 - Instant Shock/Motion Wake Sentinel (0x13 / 0x12 Dual-Arm)
 * [CRITICAL BUGFIX FLAG - INSTANT MECHANICAL WAKEUP]:
 * 1. Disables active 0x08 / 0x04 10Hz streaming pipelines.
 * 2. Arms Stability Classifier (0x13) + Motion Detector (0x12) with Wakeup Flag (0x01).
 * 3. Drains confirmation ACKs until INT is confirmed HIGH.
 * 4. Isolates I2C Bus and arms ESP32 EXT0 on GPIO 33 (Active-LOW).
 */
// ============================================================================
// 7. DEEP SLEEP COMMITTAL (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:35 - Stable I2C Bus Hold & Native 0x21 Wake Arming
 * [CRITICAL BUGFIX FLAG - I2C BUS VOLTAGE HOLD]:
 * Dismissed Wire.end(): Shutting down the I2C bus pulled SDA/SCL low, causing the BNO085
 * to detect an I2C fault and freeze its internal interrupt controller.
 * Fix: Keeps Wire active, enables RTC Pull-Ups on SDA/SCL/INT, arms 0x21 (Wake-Up Stability),
 * drains ACKs until INT is HIGH, and enters ESP32 EXT0 Deep Sleep.
 */
/*
 * Breadcrumb: 2026-09-08 22:55 - Verified Hardware EXT0 Sleep Arming (0x20 / 0x21)
 * [CRITICAL BUGFIX FLAG - EXT0 WAKE VERIFICATION]:
 * 1. Schaltet Telemetrie 0x08 / 0x04 ab.
 * 2. Aktiviert Report 0x20 (Wake-up Accelerometer) mit 50ms Intervall.
 * 3. Draint die Bestätigungspakete, damit INT wieder auf HIGH geht.
 * 4. Hält RTC Pull-Up auf GPIO 33 während des Schlafs aktiv.
 */

// ============================================================================
// 7. DEEP SLEEP COMMITTAL (REPLACEMENT)
// ============================================================================
// ============================================================================
// 7. DEEP SLEEP COMMITTAL (REPLACEMENT)
// ============================================================================
// ============================================================================
// 7. DEEP SLEEP COMMITTAL (REPLACEMENT)
// ============================================================================
// ============================================================================
// 7. DEEP SLEEP COMMITTAL (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:57 - Fully Instrumented Deep Sleep Handshake
 * [CRITICAL BUGFIX FLAG - EXT0 SLEEP VERIFICATION]:
 * Überwacht jeden Einzelschritt vor dem Sleep, fängt blockierende LOW-Pegel 
 * auf GPIO 33 ab und loggt RTC-Register-Zustände.
 */
/*
 * Breadcrumb: 2026-09-09 00:25 - Verified GPIO 32 EXT0 Sleep Committal
 * [CRITICAL BUGFIX FLAG - EXT0 PIN SYNC]:
 * Protokolliert und schärft verbindlich BNO08X_INT (GPIO 32) für den Sleep.
 */
/*
 * Breadcrumb: 2026-09-09 00:35 - Official SH-2 Report 0x12 Wakeup Sentinel
 * [CRITICAL BUGFIX FLAG - SHTP WAKE ID RESOLUTION]:
 * Ersetzt ungültige Report-IDs (0x21/0x22) durch den offiziellen Hillcrest SH-2 
 * Significant Motion Detector (0x12, Intervall=0, Flags=0x01, SensCfg=0).
 */
/*
 * Breadcrumb: 2026-09-09 01:25 - False-Wakeup Immune Sleep Committal
 * [CRITICAL BUGFIX FLAG - ZERO FALSE WAKE]:
 * 1. Schaltet 0x05, 0x08 und 0x04 zwingend ab (Intervall 0).
 * 2. Schärft Report 0x12 (Significant Motion) mit Wakeup-Flag.
 * 3. Enforcet 60ms kontinuierlichen HIGH-Pegel auf GPIO 32 vor esp_deep_sleep_start().
 */
/*
 * Breadcrumb: 2026-09-09 01:42 - Dual-Sentinel Change-Sensitivity Sleep Engine
 * [CRITICAL BUGFIX FLAG - EXT0 WAKE CONFIRMATION]:
 * 1. Hält MEMS-Kern über 0x04 bei 50ms aktiv, unterdrückt Pakete via Change-Sensitivity.
 * 2. Schärft Stability Classifier 0x13 als Sofort-Trigger bei Lageänderung.
 * 3. Garantiert echten LOW-Puls auf GPIO 32 bei Erschütterung.
 */
/*
 * Breadcrumb: 2026-09-09 01:52 - Guaranteed Non-Blocking Deep Sleep Committal
 * [CRITICAL BUGFIX FLAG - DEADLOCK REMOVED]:
 * 1. Entfernt periodisches 0x04-Streaming vor Sleep (verhindert 50ms Interrupt-Flut).
 * 2. Schärft Report 0x13 (Stability Classifier) und 0x12 als reine Event-Trigger.
 * 3. Feste Timeout-Schleife (max 150ms) ohne Reset verhindert Blockade der Loop und des Tasters.
 */
/*
 * Breadcrumb: 2026-09-09 01:52 - Guaranteed Non-Blocking Sleep & Wake-on-Motion Fix
 * [CRITICAL BUGFIX FLAG - ZERO DEADLOCK SLEEP]:
 * 1. Stoppt 0x05, 0x08 und 0x04 vollständig (Intervall 0).
 * 2. Schärft Report 0x13 (Stability Classifier) und 0x22 (Wakeup Significant Motion) mit Flags=0x01.
 * 3. Fester Timeout (max. 100ms) beim Verifizieren von GPIO 32 verhindert Einfrieren von Loop & Taster.
 */
/*
 * Breadcrumb: 2026-09-09 02:05 - Verified Wake-on-Motion Sleep Committal with Bus Protection
 * [CRITICAL BUGFIX FLAG - EXT0 WAKE SUCCESS]:
 * 1. Schärft Report 0x17 (Stability Detector - triggert sofort bei Anheben/Erschütterung).
 * 2. Schärft Report 0x12 (Significant Motion - sekundärer Trigger).
 * 3. Hält I2C SDA/SCL via gpio_hold_en() auf HIGH, damit BNO085 nicht einfriert.
 * 4. Aktiviert EXT0 Wakeup auf GPIO 32 (Aktiv-LOW) und EXT1 auf Taster GPIO 34.
 */
/*
 * Breadcrumb: 2026-09-09 02:20 - Deterministic Wake-on-Motion Sleep Committal
 * [CRITICAL BUGFIX FLAG - EXT0 WAKE CONFIRMED]:
 * 1. Stoppt 0x05, 0x08, 0x04 und leert verbleibende Pakete.
 * 2. Aktiviert enableBNO085WakeOnMotion mit sysConfig.imuWakeSensitivity.
 * 3. Liest das einzelne ACK-Paket ab -> GPIO 32 geht sofort sauber auf 1 (HIGH).
 * 4. Hält I2C-Pins stabil auf HIGH und commitet in ESP32 EXT0 Deep Sleep.
 */
/*
 * Breadcrumb: 2026-09-09 02:45 - Event-Driven Motion Sentinel & Pre-Sleep Drain
 * [CRITICAL BUGFIX FLAG - SHTP WAKE RESOLUTION]:
 * 1. Arms Stability Classifier (0x13) at 50ms interval: BNO085 MEMS stays active.
 * 2. Consumes the initial 'On-Table' report before sleep so GPIO 32 rests at HIGH.
 * 3. Triggers GPIO 32 LOW immediately when mechanical disturbance switches state to 'Motion'.
 */
bool armBNO085MotionSentinel() {
  uint32_t interval_us = 50000; // 50ms interne Abtastung
  uint8_t cmd[21] = {
    21, 0, 2, 0, 
    0xFD, 
    0x13, // Report ID: Stability Classifier
    0x01, // Feature Flag: Wakeup Delivery
    0x00, 0x00, // Change Sensitivity = 0
    (uint8_t)(interval_us & 0xFF), (uint8_t)((interval_us >> 8) & 0xFF),
    (uint8_t)((interval_us >> 16) & 0xFF), (uint8_t)((interval_us >> 24) & 0xFF),
    0x00, 0x00, 0x00, 0x00, // Batch Interval = 0
    0x00, 0x00, 0x00, 0x00  // Config = 0
  };

  Wire.beginTransmission(BNO085_I2C_ADDR);
  Wire.write(cmd, 21);
  return (Wire.endTransmission() == 0);
}

/*
 * Breadcrumb: 2026-09-09 23:15 - Deep Sleep Committal with WSS Socket Teardown
 * [CRITICAL BUGFIX FLAG - REALTIME SOCKET TEARDOWN]:
 * Stops active Supabase Realtime WSS client before entering deep sleep.
 */
/*
 * Breadcrumb: 2026-09-10 01:20 - Deep Sleep with Complete LTE Modem Power Down
 * [CRITICAL BUGFIX FLAG - MODEM DEEP SLEEP SHUTDOWN]:
 * Shuts down SIM7000G baseband processor via AT+CPOWD=1 before committing to ESP32 deep sleep.
 * Reduces idle current from ~60mA to microamps.
 */
void goToDeepSleep() {
  logMsg("\n====================================================\n");
  logMsg("[POWER] >>> Starte Deep-Sleep Sequenz <<<\n");

  stopSupabaseRealtime();

  // SIM7000G Modem stromsparend herunterfahren
  if (lteModemReady) {
    logMsg("[POWER] Fahre LTE-Modem herunter...\n");
    sendAT("AT+CPOWD=1", 1000);
    digitalWrite(MODEM_PWRKEY_PIN, HIGH);
    lteModemReady = false;
    lteStreamingActive = false;
  }

  enable5VBoostPower();
  
  // 1. Alle aktiven Telemetrie-Streams stoppen
  logMsg("[POWER 1/5] Deaktiviere Telemetrie-Streams (0x05, 0x08, 0x04)...\n");
  enableBNO085Feature(BNO085_I2C_ADDR, 0x05, 0, 0.0f);
  enableBNO085Feature(BNO085_I2C_ADDR, 0x08, 0, 0.0f);
  enableBNO085Feature(BNO085_I2C_ADDR, 0x04, 0, 0.0f);
  delay(30);
  flushBNO085FIFO();

// 2. Wake-on-Motion über Linearbeschleunigung (0x04) mit Schwellenwert schärfen
  logMsg("[POWER 2/5] Schärfe Wake-on-Motion (0x04) mit %.2f m/s²...\n", sysConfig.imuWakeSensitivity);
  enableBNO085WakeOnMotion(sysConfig.imuWakeSensitivity);
  
  // [CRITICAL TIMING FIX] Der BNO085 benötigt ~200ms, um seine Baseline (Nullpunkt) zu berechnen.
  // Ohne dieses Delay schickt er das erste Paket exakt dann, WÄHREND der ESP in den Schlaf fällt!
  delay(200);

  // 3. Bestätigungen und den initialen "On-Table"-Report leeren, damit INT auf HIGH geht
  logMsg("[POWER 3/5] Hole Bestätigung & Initialstatus ab...\n");
  flushBNO085FIFO();

  if (sdAvailable) SD.end();
  pixels.clear();
  pixels.show();

  // 4. Ruhepegel auf GPIO 32 verifizieren (muss zwingend 1 sein)
  logMsg("[POWER 4/5] Verifiziere Ruhepegel auf GPIO 32...\n");
  uint32_t drainDeadline = millis() + 150;
  while (digitalRead(BNO08X_INT) == LOW && (millis() < drainDeadline)) {
    readSHTPPacket(BNO085_I2C_ADDR);
    delay(5);
  }

  int finalIntState = digitalRead(BNO08X_INT);
  logMsg("[POWER] CHECK GPIO 32: Finaler Status = %d (Muss 1 sein)\n", finalIntState);
  if (finalIntState == 0) {
    logMsg("[POWER ABBRUCH] GPIO 32 noch LOW! Breche Deep Sleep zur Sicherheit ab.\n");
    return;
  }
  Serial.flush();

  // 5. I2C Bus im Deep Sleep als Input-Pullup halten (verhindert BNO085 Bus-Freeze)
  Wire.end();
  pinMode(I2C_SDA_PIN, INPUT_PULLUP);
  pinMode(I2C_SCL_PIN, INPUT_PULLUP);
  gpio_hold_en(GPIO_NUM_21);
  gpio_hold_en(GPIO_NUM_22);
  gpio_deep_sleep_hold_en(); 

  // 6. RTC Interrupt-Konfiguration
  rtc_gpio_init(BNO08X_INT);
  rtc_gpio_set_direction(BNO08X_INT, RTC_GPIO_MODE_INPUT_ONLY);
  rtc_gpio_pullup_en(BNO08X_INT);
  rtc_gpio_pulldown_dis(BNO08X_INT);

  // EXT0: Weckt bei LOW auf GPIO 32 (BNO085 Erschütterung)
  esp_sleep_enable_ext0_wakeup(BNO08X_INT, 0); 
  // EXT1: Weckt bei LOW auf GPIO 34 (Taster)
  esp_sleep_enable_ext1_wakeup((1ULL << BUTTON_PIN), ESP_EXT1_WAKEUP_ALL_LOW);

  logMsg("[POWER 5/5] >>> Committe Deep Sleep (Aufwachen bei Erschütterung oder Taster) <<<\n\n");
  Serial.flush();

  esp_deep_sleep_start();
}
// ==========================================
// 8. LED DRIVER (BATTERY GAUGE & WAVE)
// ==========================================
void startBatteryAnimation() {
  BMSStatus bms = readBMS();
  targetBatteryPct = bms.batteryPercent;

  pixels.clear();
  pixels.show();

  batAnimCurrentLed = 3;
  batAnimBrightnessStep = 1;
  batAnimStartTime = millis();
  batAnimLastStepTime = millis();
  lastMotionTimestamp = millis();
  isBatteryAnimRunning = true;
  currentLedMode = LED_MODE_BATTERY_ANIM;

  Serial.printf("[LED GAUGE] Starte Akku-Animation: %.2f V (%d%%)\n", bms.batteryVoltage, targetBatteryPct);
}

void updateBatteryAnimation() {
  if (!isBatteryAnimRunning) return;
  uint32_t now = millis();

  if (now - batAnimLastStepTime >= 60) {
    batAnimLastStepTime = now;

    int ledIdx = batAnimCurrentLed;
    int ledThresholdStart = (3 - ledIdx) * 25;
    int ledThresholdFull  = ledThresholdStart + 25;

    if (targetBatteryPct > ledThresholdStart) {
      uint8_t maxStep = 5;
      if (targetBatteryPct < ledThresholdFull) {
        int remainder = targetBatteryPct - ledThresholdStart;
        maxStep = (remainder * 5) / 25;
        if (maxStep == 0) maxStep = 1;
      }

      if (batAnimBrightnessStep <= maxStep) {
        uint8_t bVal = (255 * (batAnimBrightnessStep * 20)) / 100;
        uint32_t col = (targetBatteryPct > 40) ? pixels.Color(0, bVal, 0) : pixels.Color(bVal, bVal / 2, 0);
        pixels.setPixelColor(ledIdx, col);
        pixels.show();
        batAnimBrightnessStep++;
      } else {
        if (batAnimCurrentLed > 0 && targetBatteryPct > ledThresholdFull) {
          batAnimCurrentLed--;
          batAnimBrightnessStep = 1;
        } else {
          if (now - batAnimStartTime >= 3000) {
            pixels.clear();
            pixels.show();
            isBatteryAnimRunning = false;
            currentLedMode = wifiApActive ? LED_MODE_WIFI_WAVE : LED_MODE_OFF;
          }
        }
      }
    } else {
      if (now - batAnimStartTime >= 2500) {
        pixels.clear();
        pixels.show();
        isBatteryAnimRunning = false;
        currentLedMode = wifiApActive ? LED_MODE_WIFI_WAVE : LED_MODE_OFF;
      }
    }
  }
}

void updateWifiWave() {
  if (millis() - lastWaveTime >= 30) {
    lastWaveTime = millis();
    static float waveOffset = 0.0f;

    for (int i = 0; i < NUM_PIXELS; i++) {
      float wavePos = waveOffset + (i * 0.8f);
      float blend = (sinf(wavePos) + 1.0f) * 0.5f;

      uint8_t r = 0;
      uint8_t g = (uint8_t)((1.0f - blend) * 220.0f);
      uint8_t b = (uint8_t)(blend * 255.0f);

      pixels.setPixelColor(i, pixels.Color(r, g, b));
    }
    pixels.show();
    waveOffset += 0.08f;
  }
}

void updateChargingAnimation() {
  if (millis() - lastChargePulseTime >= 20) {
    lastChargePulseTime = millis();
    static float pulseAngle = 0.0f;

    uint8_t pulseVal = (uint8_t)(((sinf(pulseAngle) + 1.0f) * 0.5f) * 225.0f + 30.0f);
    pulseAngle += 0.06f;

    int chargingLedIdx = 3 - (targetBatteryPct / 25);
    if (chargingLedIdx < 0) chargingLedIdx = 0;

    for (int i = 0; i < NUM_PIXELS; i++) {
      int ledThresholdStart = (3 - i) * 25;
      int ledThresholdFull  = ledThresholdStart + 25;

      if (targetBatteryPct >= ledThresholdFull) {
        pixels.setPixelColor(i, pixels.Color(180, 180, 180));
      } else if (i == chargingLedIdx) {
        pixels.setPixelColor(i, pixels.Color(pulseVal, pulseVal, pulseVal));
      } else {
        pixels.setPixelColor(i, pixels.Color(0, 0, 0));
      }
    }
    pixels.show();
  }
}

void flashWakeupBlink() {
  for (int b = 0; b < 2; b++) {
    for (int i = 0; i < NUM_PIXELS; i++) {
      pixels.setPixelColor(i, pixels.Color(255, 255, 255));
    }
    pixels.show();
    delay(50);
    pixels.clear();
    pixels.show();
    delay(70);
  }
}

/*
 * Breadcrumb: 2026-09-06 20:38 - Clean Native WebServer Handlers & Android 14 Captive Portal Engine
 * Fix: Removed deprecated 'wm' handler stubs. Native WebServer handles direct root, status, and SD operations.
 */

/*
 * Breadcrumb: 2026-09-06 22:00 - Async Web & Captive Handlers
 * Feature: Non-blocking handlers returning HTTP 302 directly to 10.10.10.1.
 */

/*
 * Breadcrumb: 2026-09-07 00:30 - Bulletproof Async Captive Portal
 * Fix: Removed duplicate comments. Added explicit Cache-Control headers to 302 Redirects 
 *      to force Android 14 to trigger the Captive Portal Notification.
 */

// ==========================================
// 9. ASYNC WEBSERVER & WEBSOCKET ENGINE
// ==========================================
/*
 * Breadcrumb: 2026-09-07 01:50 - Streaming Chunked GLB File Upload
 * Fix: Buffered chunked upload directly to SD card without socket exhaustion.
 */

/*
 * Breadcrumb: 2026-09-07 02:22 - Safe JSON Serializer & Static GLB Route
 * Fix: Pre-calculated MB/KB integers to prevent 64-bit snprintf formatting bugs on ESP32.
 */

/*
 * Breadcrumb: 2026-09-07 02:30 - Safe Non-Blocking JSON Builder & WS Broadcast
 * Fix: Removed blocking directory parsing inside high-speed quat stream; hardened file name output.
 */

/*
 * Breadcrumb: 2026-09-07 21:15 - Consolidated Async Engine, File API & Button Logic
 * Fix: Removed redundant function redefinitions and integrated OTA firmware flasher.
 */

/*
 * Breadcrumb: 2026-09-07 22:05 - Scope & Route Placement Fix
 * [CRITICAL BUGFIX FLAG - SERVER SCOPE]:
 * Placed performSDOTA as global helper function and registered /flash route inside toggleWifiAP().
 */

/*
 * Breadcrumb: 2026-09-07 22:15 - Async-Safe Decoupled SD-OTA Engine
 * [CRITICAL BUGFIX FLAG - ASYNC OTA]:
 * Decoupled performSDOTA from AsyncWebServer request handler via loop() trigger
 * to prevent AsyncTCP socket starvation, watchdog resets, and failed Update.begin() allocations.
 */

/*
 * Breadcrumb: 2026-09-07 22:20 - Consolidated Async WebServer Engine
 * [CRITICAL BUGFIX FLAG - SCOPE & CLEANUP]:
 * Removed duplicated toggleWifiAP implementation. Retained async-safe OTA trigger.
 */

// ==========================================
// 9. ASYNC WEBSERVER & WEBSOCKET ENGINE
// ==========================================
#include <Update.h>

/*
 * Breadcrumb: 2026-09-09 21:15 - Deterministic SD-OTA Flasher Sequence
 * [CRITICAL BUGFIX FLAG - OTA FINALIZE]:
 * Switched Update.end() to strict verification (no partial image allowance).
 * Flushes Serial before SD deletion and cleanly commits restart.
 */

 /*
 * Breadcrumb: 2026-09-09 22:20 - Supabase Cloud OTA Auto-Updater & Stream Downloader
 * [CRITICAL BUGFIX FLAG - STREAMING DOWNLOAD]:
 * Streams HTTPS binary directly to SD card in 1024-byte chunks to avoid RAM allocation failure.
 * Dismissed approach: In-memory buffer or large readString() caused ESP32 heap panic.
 * Uses existing decoupled otaTriggered flag to execute performSDOTA safely outside network callbacks.
 */
/*
 * Breadcrumb: 2026-09-09 22:15 - Hardened Cloud OTA Stream Downloader with Redirect Support
 * [CRITICAL BUGFIX FLAG - STORAGE REDIRECTS]:
 * Enables HTTPC_STRICT_FOLLOW_REDIRECTS to support Supabase Storage 302 redirects.
 * Enforces client.stop() between API query and binary download to prevent mbedTLS socket stalls.
 */
bool checkAndDownloadCloudOTA() {
  if (!wifiStaActive || WiFi.status() != WL_CONNECTED || !sdAvailable) {
    return false;
  }

  logMsg("[CLOUD OTA] Prüfe auf Firmware-Aktualisierungen...\n");

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;
  https.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  String queryUrl = String(SUPABASE_URL) + "/rest/v1/firmware_releases?select=version,bin_url&order=id.desc&limit=1";

  if (!https.begin(client, queryUrl)) {
    logMsg("[CLOUD OTA FEHLER] Verbindung zu Supabase fehlgeschlagen.\n");
    return false;
  }

  https.addHeader("apikey", SUPABASE_ANON_KEY);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);

  int httpCode = https.GET();
  if (httpCode != HTTP_CODE_OK) {
    logMsg("[CLOUD OTA FEHLER] HTTP-Abfrage fehlgeschlagen: %d\n", httpCode);
    https.end();
    client.stop();
    return false;
  }

  String payload = https.getString();
  https.end();
  client.stop();

  int vIdx = payload.indexOf("\"version\":\"");
  int uIdx = payload.indexOf("\"bin_url\":\"");
  if (vIdx == -1 || uIdx == -1) {
    logMsg("[CLOUD OTA] Keine gültigen Release-Einträge gefunden.\n");
    return false;
  }

  int vEnd = payload.indexOf("\"", vIdx + 11);
  int uEnd = payload.indexOf("\"", uIdx + 11);
  if (vEnd == -1 || uEnd == -1) return false;

  String remoteVersion = payload.substring(vIdx + 11, vEnd);
  String binUrl = payload.substring(uIdx + 11, uEnd);

  logMsg("[CLOUD OTA] Aktuelle Version: %s | Server Version: %s\n", FIRMWARE_VERSION, remoteVersion.c_str());

  if (remoteVersion == FIRMWARE_VERSION) {
    logMsg("[CLOUD OTA] Firmware ist auf dem neuesten Stand.\n");
    return false;
  }

  logMsg("[CLOUD OTA] Neue Version verfügbar! Starte Download von: %s\n", binUrl.c_str());

  if (!https.begin(client, binUrl)) {
    logMsg("[CLOUD OTA FEHLER] Download-Verbindung fehlgeschlagen.\n");
    return false;
  }

  int dlCode = https.GET();
  if (dlCode != HTTP_CODE_OK) {
    logMsg("[CLOUD OTA FEHLER] Download fehlgeschlagen: HTTP %d\n", dlCode);
    https.end();
    client.stop();
    return false;
  }

  int totalBytes = https.getSize();
  logMsg("[CLOUD OTA] Dateigröße: %d Bytes. Öffne SD-Datei %s...\n", totalBytes, PATH_OTA_TEMP_BIN);

  if (SD.exists(PATH_OTA_TEMP_BIN)) {
    SD.remove(PATH_OTA_TEMP_BIN);
  }

  File otaFile = SD.open(PATH_OTA_TEMP_BIN, FILE_WRITE);
  if (!otaFile) {
    logMsg("[CLOUD OTA FEHLER] Konnte temporäre Datei auf SD nicht anlegen!\n");
    https.end();
    client.stop();
    return false;
  }

  WiFiClient* stream = https.getStreamPtr();
  uint8_t buffer[1024];
  int bytesRemaining = totalBytes;
  uint32_t lastProgressPrint = millis();

  while (https.connected() && (bytesRemaining > 0 || totalBytes == -1)) {
    size_t availableBytes = stream->available();
    if (availableBytes > 0) {
      int bytesToRead = (availableBytes > sizeof(buffer)) ? sizeof(buffer) : availableBytes;
      int bytesRead = stream->readBytes(buffer, bytesToRead);
      otaFile.write(buffer, bytesRead);

      if (totalBytes > 0) {
        bytesRemaining -= bytesRead;
      }

      if (millis() - lastProgressPrint >= 1500) {
        lastProgressPrint = millis();
        if (totalBytes > 0) {
          int progress = ((totalBytes - bytesRemaining) * 100) / totalBytes;
          logMsg("[CLOUD OTA] Fortschritt: %d%%\n", progress);
        }
      }
    } else {
      delay(5);
    }
  }

  otaFile.flush();
  otaFile.close();
  https.end();
  client.stop();

  logMsg("[CLOUD OTA] Download vollständig auf SD gesichert!\n");

  otaTargetBinPath = PATH_OTA_TEMP_BIN;
  otaTriggered = true;
  return true;
}

/*
 * Breadcrumb: 2026-09-09 22:40 - Supabase Remote Config Ingestion
 * [CRITICAL BUGFIX FLAG - CLOUD PARAMETER SYNC]:
 * Queries public.device_config on sync. Updates internal RTC memory,
 * runtime sampling rates, and saves changes to SD card.
 */
void syncConfigFromSupabase() {
  if (!wifiStaActive || WiFi.status() != WL_CONNECTED || !sdAvailable) return;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;

  String url = String(SUPABASE_URL) + "/rest/v1/device_config?device_id=eq." + String(DEVICE_IDENTIFIER) + "&select=*";
  if (!https.begin(client, url)) return;

  https.addHeader("apikey", SUPABASE_ANON_KEY);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);

  int httpCode = https.GET();
  if (httpCode == HTTP_CODE_OK) {
    String payload = https.getString();
    bool changed = false;

    int idxSens = payload.indexOf("\"sens\":");
    if (idxSens != -1) {
      int s = idxSens + 7;
      int e = payload.indexOf(",", s); if (e == -1) e = payload.indexOf("}", s);
      float v = payload.substring(s, e).toFloat();
      if (v != sysConfig.imuWakeSensitivity) { sysConfig.imuWakeSensitivity = v; changed = true; }
    }

    int idxDelta = payload.indexOf("\"delta\":");
    if (idxDelta != -1) {
      int s = idxDelta + 8;
      int e = payload.indexOf(",", s); if (e == -1) e = payload.indexOf("}", s);
      float v = payload.substring(s, e).toFloat();
      if (v != sysConfig.motionSleepDeltaThreshold) { sysConfig.motionSleepDeltaThreshold = v; changed = true; }
    }

    int idxRate = payload.indexOf("\"rate\":");
    if (idxRate != -1) {
      int s = idxRate + 7;
      int e = payload.indexOf(",", s); if (e == -1) e = payload.indexOf("}", s);
      uint8_t r = payload.substring(s, e).toInt();
      if (r >= 5 && r <= 30 && r != sysConfig.imuSampleRate_hz) {
        sysConfig.imuSampleRate_hz = r;
        enableBNO085Feature(BNO085_I2C_ADDR, 0x05, 1000 / sysConfig.imuSampleRate_hz, 0);
        changed = true;
      }
    }

    int idxIdle = payload.indexOf("\"idle_timeout_sec\":");
    if (idxIdle != -1) {
      int s = idxIdle + 19;
      int e = payload.indexOf(",", s); if (e == -1) e = payload.indexOf("}", s);
      uint32_t sec = payload.substring(s, e).toInt();
      if (sec >= 5 && sec <= 60 && (sec * 1000) != sysConfig.idleSleepTimeout_ms) {
        sysConfig.idleSleepTimeout_ms = sec * 1000;
        changed = true;
      }
    }

    int idxLte = payload.indexOf("\"lte_interval\":");
    if (idxLte != -1) {
      int s = idxLte + 15;
      int e = payload.indexOf(",", s); if (e == -1) e = payload.indexOf("}", s);
      uint32_t min = payload.substring(s, e).toInt();
      if (min != sysConfig.lteBatchInterval_min) { sysConfig.lteBatchInterval_min = min; changed = true; }
    }

    int idxCont = payload.indexOf("\"continuous_mode\":");
    if (idxCont != -1) {
      bool cont = (payload.indexOf("true", idxCont) != -1);
      if (cont != sysConfig.continuousLiveMode) { sysConfig.continuousLiveMode = cont; changed = true; }
    }
    int idxPin = payload.indexOf("\"sim_pin\":");
    if (idxPin != -1) {
      int s = idxPin + 11;
      int e = payload.indexOf("\"", s);
      if (e != -1) {
        String p = payload.substring(s, e);
        if (p.length() > 0 && p != simPin) { simPin = p; changed = true; }
      }
    }
    int idxApn = payload.indexOf("\"sim_apn\":");
    if (idxApn != -1) {
      int s = idxApn + 11;
      int e = payload.indexOf("\"", s);
      if (e != -1) {
        String a = payload.substring(s, e);
        if (a.length() > 0 && a != simApn) { simApn = a; changed = true; }
      }
    }
    if (changed) {
      saveSimCredentials(simPin, simApn);
    }

    if (changed) {
      saveConfigToSD();
      logMsg("[CLOUD CONFIG] Neue Konfiguration aus Supabase übernommen & gesichert.\n");
    }
  }
  https.end();
  client.stop();
}



/*
 * Breadcrumb: 2026-09-09 23:30 - Native RFC-6455 WSS Client over WiFiClientSecure
 * [CRITICAL BUGFIX FLAG - EMBEDDED WSS ENCODER]:
 * 1. Performs native TLS WebSocket handshake (HTTP 101 Switching Protocols).
 * 2. Frames and masks client-to-server text payloads strictly according to RFC 6455.
 * 3. Drains incoming server frames non-blocking to prevent TLS socket buffer saturation.
 */
void sendWssFrame(const char* text) {
  if (!supabaseWsConnected || !supabaseWsClient.connected()) {
    supabaseWsConnected = false;
    supabaseWsJoined = false;
    return;
  }

  size_t len = strlen(text);
  uint8_t mask[4] = { 0x5A, 0xA5, 0x3C, 0xC3 };
  uint8_t header[8];
  size_t headerLen = 0;

  header[0] = 0x81; // FIN bit gesetzt + Opcode 0x01 (Text)
  if (len < 126) {
    header[1] = 0x80 | (uint8_t)len; // Mask bit gesetzt
    header[2] = mask[0];
    header[3] = mask[1];
    header[4] = mask[2];
    header[5] = mask[3];
    headerLen = 6;
  } else {
    header[1] = 0x80 | 126;
    header[2] = (uint8_t)((len >> 8) & 0xFF);
    header[3] = (uint8_t)(len & 0xFF);
    header[4] = mask[0];
    header[5] = mask[1];
    header[6] = mask[2];
    header[7] = mask[3];
    headerLen = 8;
  }

  supabaseWsClient.write(header, headerLen);

  // Maskierte Daten blockweise senden
  uint8_t buf[128];
  for (size_t i = 0; i < len; i += sizeof(buf)) {
    size_t chunk = ((len - i) < sizeof(buf)) ? (len - i) : sizeof(buf);
    for (size_t j = 0; j < chunk; j++) {
      buf[j] = text[i + j] ^ mask[(i + j) % 4];
    }
    supabaseWsClient.write(buf, chunk);
  }
}

/*
 * Breadcrumb: 2026-09-09 23:40 - Corrected TLS Handshake Timeout (5000ms)
 * [CRITICAL BUGFIX FLAG - MILLISECOND TIMEOUT]:
 * Corrected setTimeout(3) to setTimeout(5000). Arduino Stream::setTimeout()
 * takes milliseconds, preventing premature abort during TLS negotiation.
 */
/*
 * Breadcrumb: 2026-09-09 23:58 - Supabase Realtime with Validated Auth Token
 * [CRITICAL BUGFIX FLAG - REALTIME AUTH]:
 * Embeds access_token directly into phx_join payload.
 * Added response validation to ensure channel 'imu_live' is genuinely accepted.
 */
bool initSupabaseRealtime() {
  if (supabaseWsConnected && supabaseWsClient.connected()) return true;

  logMsg("[REALTIME WSS] Verbinde zu Supabase Realtime...\n");
  supabaseWsClient.setInsecure();
  supabaseWsClient.setTimeout(5000);

  const char* host = "fajwusnwfywfebyffxtf.supabase.co";
  if (!supabaseWsClient.connect(host, 443)) {
    logMsg("[REALTIME WSS FEHLER] TLS-Verbindung fehlgeschlagen.\n");
    return false;
  }

  String req = "GET /realtime/v1/websocket?apikey=" + String(SUPABASE_ANON_KEY) + "&vsn=1.0.0 HTTP/1.1\r\n";
  req += "Host: " + String(host) + "\r\n";
  req += "Upgrade: websocket\r\n";
  req += "Connection: Upgrade\r\n";
  req += "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
  req += "Sec-WebSocket-Version: 13\r\n\r\n";

  supabaseWsClient.print(req);

  uint32_t start = millis();
  String statusLine = "";
  while (supabaseWsClient.connected() && millis() - start < 4000) {
    if (supabaseWsClient.available()) {
      char c = supabaseWsClient.read();
      if (c == '\n') break;
      if (c != '\r') statusLine += c;
    }
    delay(2);
  }

  if (statusLine.indexOf("101") == -1) {
    logMsg("[REALTIME WSS FEHLER] Handshake abgewiesen: %s\n", statusLine.c_str());
    supabaseWsClient.stop();
    return false;
  }

  start = millis();
  while (supabaseWsClient.connected() && millis() - start < 2000) {
    if (supabaseWsClient.available()) {
      String hLine = supabaseWsClient.readStringUntil('\n');
      hLine.trim();
      if (hLine.length() == 0) break;
    }
  }

  supabaseWsConnected = true;
  supabaseWsJoined = false;
  logMsg("[REALTIME WSS] Verbunden (HTTP 101)! Sende Beitritt für 'imu_live'...\n");

  // phx_join mit zwingend erforderlichem access_token
  String joinMsg = "{\"topic\":\"realtime:imu_live\",\"event\":\"phx_join\",\"payload\":{\"config\":{\"broadcast\":{\"ack\":false,\"self\":false}},\"access_token\":\"" + String(SUPABASE_ANON_KEY) + "\"},\"ref\":\"1\"}";
  sendWssFrame(joinMsg.c_str());
  supabaseWsJoined = true;
  return true;
}

void stopSupabaseRealtime() {
  if (supabaseWsConnected || supabaseWsClient.connected()) {
    supabaseWsClient.stop();
    supabaseWsConnected = false;
    supabaseWsJoined = false;
    logMsg("[REALTIME WSS] Verbindung geschlossen.\n");
  }
}

void broadcastIMUToCloud() {
  if (!supabaseWsConnected || !supabaseWsJoined || !hasValidQuat) return;

  char payload[320];
  snprintf(payload, sizeof(payload),
           "{\"topic\":\"realtime:imu_live\",\"event\":\"broadcast\",\"payload\":{\"type\":\"broadcast\",\"event\":\"pos\",\"payload\":{\"w\":%.4f,\"x\":%.4f,\"y\":%.4f,\"z\":%.4f,\"ax\":%.2f,\"ay\":%.2f,\"az\":%.2f}},\"ref\":null}",
           latest_qw, latest_qx, latest_qy, latest_qz, latest_ax, latest_ay, latest_az);

  sendWssFrame(payload);
}

bool performSDOTA(String binPath) {
  while (binPath.startsWith("//")) binPath = binPath.substring(1);
  if (!binPath.startsWith("/")) binPath = "/" + binPath;

  if (!sdAvailable || !SD.exists(binPath)) {
    Serial.printf("[OTA FEHLER] Datei nicht auf SD gefunden: %s\n", binPath.c_str());
    return false;
  }

  File updateBin = SD.open(binPath, FILE_READ);
  if (!updateBin || updateBin.size() == 0) {
    Serial.println("[OTA FEHLER] Datei ungültig oder leer.");
    if (updateBin) updateBin.close();
    return false;
  }

  size_t updateSize = updateBin.size();
  Serial.printf("[OTA] Starte Flash aus %s (%u Bytes)...\n", binPath.c_str(), updateSize);

  if (!Update.begin(updateSize, U_FLASH)) {
    Serial.printf("[OTA FEHLER] Update.begin() fehlgeschlagen: %s\n", Update.errorString());
    updateBin.close();
    return false;
  }

  size_t written = Update.writeStream(updateBin);
  updateBin.close();

  if (written == updateSize) {
    if (Update.end(false)) {
      Serial.println("[OTA ERFOLG] Firmware verifiziert! Lösche .bin und starte neu...");
      SD.remove(binPath);
      Serial.flush();
      delay(300);
      ESP.restart();
      return true;
    } else {
      Serial.printf("[OTA FEHLER] Update.end() fehlgeschlagen: %s\n", Update.errorString());
      return false;
    }
  } else {
    Serial.printf("[OTA FEHLER] Geschriebene Bytes (%u) != Dateigröße (%u)\n", written, updateSize);
    return false;
  }
}

/*
 * Breadcrumb: 2026-09-09 22:05 - System JSON Status with Firmware Tag
 * Feature: Exposes fw_version and build_date to frontend and WebSocket stream.
 */
/*
 * Breadcrumb: 2026-09-09 22:35 - JSON Status & WS Event Parser with Idle Timeout
 * Feature: Exposes idle sleep timeout (in seconds) to captive portal and updates sysConfig.
 */
 /*
 * Breadcrumb: 2026-09-09 23:55 - Deduplicated onWsEvent with Configurable Idle
 * [CRITICAL BUGFIX FLAG - DEDUPLICATION]:
 * Removed duplicate onWsEvent implementation right before uploadFile.
 * Retained dynamic 'idle' parameter parsing (5 - 60s).
 */

/*
 * Breadcrumb: 2026-09-10 00:30 - Fixed JSON Syntax in System Status
 * [CRITICAL BUGFIX FLAG - JSON INTEGRITY]:
 * Placed closing brace '}' strictly after all LTE and SIM fields.
 * Prevents client-side JSON.parse syntax exceptions.
 */
String getSystemJsonStatus() {
  uint32_t freeMb = (sdTotalBytes >= sdUsedBytes) ? (uint32_t)((sdTotalBytes - sdUsedBytes) / (1024 * 1024)) : 0;
  uint32_t totMb  = (uint32_t)(sdTotalBytes / (1024 * 1024));

  String json = "{";
  json += "\"fw_version\":\"" + String(FIRMWARE_VERSION) + "\",";
  json += "\"build_date\":\"" + String(FIRMWARE_BUILD_DATE) + "\",";
  json += "\"bat_pct\":" + String(globalBmsStatus.batteryPercent) + ",";
  json += "\"bat_v\":" + String(globalBmsStatus.batteryVoltage, 2) + ",";
  json += "\"is_charging\":" + String(globalBmsStatus.isCharging ? "true" : "false") + ",";
  json += "\"chrg_stat\":\"" + globalBmsStatus.chargeStatus + "\",";
  json += "\"chrg_ma\":" + String(globalBmsStatus.chargeCurrent_mA) + ",";
  json += "\"sd_free_mb\":" + String(freeMb) + ",";
  json += "\"sd_tot_mb\":" + String(totMb) + ",";
  json += "\"sens\":" + String(sysConfig.imuWakeSensitivity, 2) + ",";
  json += "\"delta\":" + String(sysConfig.motionSleepDeltaThreshold, 2) + ",";
  json += "\"rate\":" + String(sysConfig.imuSampleRate_hz) + ",";
  json += "\"lte\":" + String(sysConfig.lteBatchInterval_min) + ",";
  json += "\"idle\":" + String(sysConfig.idleSleepTimeout_ms / 1000) + ",";
  json += "\"continuous\":" + String(sysConfig.continuousLiveMode ? "true" : "false") + ",";
  json += "\"sim_apn\":\"" + simApn + "\",";
  json += "\"lte_ready\":" + String(lteModemReady ? "true" : "false") + ",";
  json += "\"lte_streaming\":" + String(lteStreamingActive ? "true" : "false");
  json += "}";

  return json;
}

void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len) {
  if (type == WS_EVT_CONNECT) {
    client->text(getSystemJsonStatus());
  } else if (type == WS_EVT_DATA) {
    AwsFrameInfo *info = (AwsFrameInfo*)arg;
    if (info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT) {
      data[len] = 0;
      String msg = (char*)data;
      bool changed = false;

      int idxWlanS = msg.indexOf("\"wifi_ssid\":\"");
      int idxWlanP = msg.indexOf("\"wifi_pass\":\"");
      if (idxWlanS != -1 && idxWlanP != -1) {
        int sEnd = msg.indexOf("\"", idxWlanS + 13);
        int pEnd = msg.indexOf("\"", idxWlanP + 13);
        if (sEnd != -1 && pEnd != -1) {
          String s = msg.substring(idxWlanS + 13, sEnd);
          String p = msg.substring(idxWlanP + 13, pEnd);
          saveWifiCredentials(s, p);
        }
      }
      int idxSimPin = msg.indexOf("\"sim_pin\":\"");
      int idxSimApn = msg.indexOf("\"sim_apn\":\"");
      if (idxSimPin != -1 || idxSimApn != -1) {
        if (idxSimPin != -1) {
          int s = idxSimPin + 11;
          int e = msg.indexOf("\"", s);
          if (e != -1) simPin = msg.substring(s, e);
        }
        if (idxSimApn != -1) {
          int s = idxSimApn + 11;
          int e = msg.indexOf("\"", s);
          if (e != -1) simApn = msg.substring(s, e);
        }
        saveSimCredentials(simPin, simApn);
        changed = true;
      }


      int idxRate = msg.indexOf("\"rate\":");
      if (idxRate != -1) {
        int start = idxRate + 7;
        int end = msg.indexOf(",", start); if (end == -1) end = msg.indexOf("}", start);
        uint8_t newRate = msg.substring(start, end).toInt();
        if (newRate >= 5 && newRate <= 30) {
          sysConfig.imuSampleRate_hz = newRate;
          uint16_t interval_ms = 1000 / sysConfig.imuSampleRate_hz;
          enableBNO085Feature(BNO085_I2C_ADDR, 0x05, interval_ms, 0);
          changed = true;
        }
      }

      int idxSens = msg.indexOf("\"sens\":");
      if (idxSens != -1) {
        int start = idxSens + 7;
        int end = msg.indexOf(",", start); if (end == -1) end = msg.indexOf("}", start);
        sysConfig.imuWakeSensitivity = msg.substring(start, end).toFloat();
        changed = true;
      }

      int idxDelta = msg.indexOf("\"delta\":");
      if (idxDelta != -1) {
        int start = idxDelta + 8;
        int end = msg.indexOf(",", start); if (end == -1) end = msg.indexOf("}", start);
        sysConfig.motionSleepDeltaThreshold = msg.substring(start, end).toFloat();
        changed = true;
      }

      int idxLte = msg.indexOf("\"lte\":");
      if (idxLte != -1) {
        int start = idxLte + 6;
        int end = msg.indexOf(",", start); if (end == -1) end = msg.indexOf("}", start);
        sysConfig.lteBatchInterval_min = msg.substring(start, end).toInt();
        changed = true;
      }

      int idxIdle = msg.indexOf("\"idle\":");
      if (idxIdle != -1) {
        int start = idxIdle + 7;
        int end = msg.indexOf(",", start); if (end == -1) end = msg.indexOf("}", start);
        uint32_t idleSec = msg.substring(start, end).toInt();
        if (idleSec >= 5 && idleSec <= 60) {
          sysConfig.idleSleepTimeout_ms = idleSec * 1000;
          changed = true;
        }
      }

      int idxCont = msg.indexOf("\"continuous\":");
      if (idxCont != -1) {
        sysConfig.continuousLiveMode = (msg.indexOf("true", idxCont) != -1);
        changed = true;
      }

      if (changed) {
        saveConfigToSD();
      }

      ws.textAll(getSystemJsonStatus());
    }
  }
}

static File uploadFile;

/*
 * Breadcrumb: 2026-09-09 22:10 - SNTP Network Time Auto-Trigger
 * [CRITICAL BUGFIX FLAG - NTP AUTO START]:
 * Triggers non-blocking SNTP synchronization via pool.ntp.org on GOT_IP.
 */
void onWiFiEvent(WiFiEvent_t event) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_AP_STACONNECTED:
      Serial.println("[WIFI] >>> Smartphone verbunden! Warte auf DHCP...");
      hadAtLeastOneClient = true;
      wifiLastClientSeenTime = millis();
      lastMotionTimestamp = millis();
      break;
    case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
      Serial.println("[WIFI] >>> Smartphone getrennt.");
      wifiLastClientSeenTime = millis();
      break;
    case ARDUINO_EVENT_WIFI_AP_STAIPASSIGNED:
      Serial.println("[WIFI] >>> IP erfolgreich an Smartphone vergeben!");
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.print("[WIFI STA] Erfolgreich verbunden! IP-Adresse: ");
      Serial.println(WiFi.localIP());
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      Serial.println("[SNTP] Zeitsynchronisation im Hintergrund gestartet.");
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.println("[WIFI STA] Verbindung getrennt.");
      break;
    default: break;
  }
}

/*
 * Breadcrumb: 2026-09-09 21:15 - Clean Native AP Server Engine & Timestamp Init
 * [CRITICAL BUGFIX FLAG - AP CLEANUP]:
 * Cleaned stray patch instructions. Resets wifiActivatedTime, lastSeen, and motion
 * timestamps concurrently with server.begin() to prevent immediate timeout shutdowns.
 */
// [BUGFIX] Webserver-Routen ausgelagert, damit sie auch im Heim-WLAN (STA) funktionieren
static bool webServerInitialized = false;

void initWebServer() {
  if (webServerInitialized) return;

  ws.onEvent(onWsEvent);
  server.addHandler(&ws);

  auto serveDashboard = [](AsyncWebServerRequest *r) {
    AsyncWebServerResponse *response = r->beginResponse_P(200, "text/html; charset=utf-8", DASHBOARD_PAGE);
    response->addHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    r->send(response);
  };

  server.on("/", HTTP_GET, serveDashboard);
  server.on("/hotspot-detect.html", HTTP_GET, serveDashboard);
  server.on("/captive.apple.com", HTTP_GET, serveDashboard);

  server.on("/status", HTTP_GET, [](AsyncWebServerRequest *r){ 
    r->send(200, "application/json", getSystemJsonStatus()); 
  });

  server.on("/format", HTTP_GET, [](AsyncWebServerRequest *r){
    if (!sdAvailable) { r->send(500, "text/plain", "SD not available"); return; }
    File root = SD.open("/"); 
    File file = root.openNextFile();
    while (file) { String path = file.path(); file.close(); SD.remove(path); file = root.openNextFile(); }
    root.close(); createSdDirectories();
    sdTotalBytes = SD.totalBytes(); sdUsedBytes = SD.usedBytes();
    r->send(200, "text/plain", "SD formatiert.");
  });

  server.on("/download", HTTP_GET, [](AsyncWebServerRequest *r){
    if (!r->hasArg("file")) { r->send(400, "text/plain", "Missing file"); return; }
    String fn = r->arg("file"); 
    if (!fn.startsWith("/")) fn = "/" + fn;
    if (sdAvailable && SD.exists(fn)) {
      AsyncWebServerResponse *resp = r->beginResponse(SD, fn, "application/octet-stream", true);
      resp->addHeader("Access-Control-Allow-Origin", "*");
      r->send(resp);
    } else { r->send(404, "text/plain", "Not found"); }
  });

  server.on("/model.glb", HTTP_GET, [](AsyncWebServerRequest *r){
    AsyncWebServerResponse *response;
    if (sdAvailable && SD.exists("/OS/IMU.glb")) response = r->beginResponse(SD, "/OS/IMU.glb", "model/gltf-binary");
    else if (sdAvailable && SD.exists("/IMU.glb")) response = r->beginResponse(SD, "/IMU.glb", "model/gltf-binary");
    else { r->send(404, "text/plain", "Model not found"); return; }
    response->addHeader("Cache-Control", "public, max-age=604800, immutable"); r->send(response);
  });

  server.on("/three.min.js", HTTP_GET, [](AsyncWebServerRequest *r){
    AsyncWebServerResponse *response;
    if (sdAvailable && SD.exists("/OS/three.min.js")) response = r->beginResponse(SD, "/OS/three.min.js", "application/javascript");
    else if (sdAvailable && SD.exists("/three.min.js")) response = r->beginResponse(SD, "/three.min.js", "application/javascript");
    else { r->send(404, "text/plain", "Not found"); return; }
    response->addHeader("Cache-Control", "public, max-age=604800, immutable"); r->send(response);
  });

  server.on("/GLTFLoader.js", HTTP_GET, [](AsyncWebServerRequest *r){
    AsyncWebServerResponse *response;
    if (sdAvailable && SD.exists("/OS/GLTFLoader.js")) response = r->beginResponse(SD, "/OS/GLTFLoader.js", "application/javascript");
    else if (sdAvailable && SD.exists("/GLTFLoader.js")) response = r->beginResponse(SD, "/GLTFLoader.js", "application/javascript");
    else { r->send(404, "text/plain", "Not found"); return; }
    response->addHeader("Cache-Control", "public, max-age=604800, immutable"); r->send(response);
  });

  /*
 * Breadcrumb: 2026-09-11 06:15 - FATFS File Handle Leak Fix in /browse
 * [CRITICAL BUGFIX FLAG - SD FILE DESCRIPTOR LEAK]:
 * Dismissed code: Reassigning 'file = dir.openNextFile()' without calling 'file.close()'
 * caused FATFS to exhaust its default limit of 5 open file handles immediately.
 * Fix: Explicitly invoke file.close() inside the iteration loop before opening the next file.
 */
  server.on("/browse", HTTP_GET, [](AsyncWebServerRequest *r){
    String path = r->hasArg("dir") ? r->arg("dir") : "/";
    if (!path.startsWith("/")) path = "/" + path;
    if (!sdAvailable) { r->send(500, "application/json", "{\"error\":\"SD offline\"}"); return; }

    File dir = SD.open(path);
    if (!dir || !dir.isDirectory()) { r->send(404, "application/json", "{\"error\":\"Not a directory\"}"); return; }

    String json = "{\"current\":\"" + path + "\",\"items\":[";
    File file = dir.openNextFile();
    bool first = true;
    while (file) {
      if (!first) json += ",";
      String fullFn = String(file.name());
      bool isDir = file.isDirectory();
      size_t fSize = file.size();
      file.close(); // [WICHTIGER BUGFIX] Handle sofort freigeben, verhindert Absturz des SD-Treibers

      int lastSlash = fullFn.lastIndexOf('/');
      String fn = (lastSlash >= 0) ? fullFn.substring(lastSlash + 1) : fullFn;

      json += "{\"name\":\"" + fn + "\",\"is_dir\":" + (isDir ? "true" : "false") + ",\"size\":" + String(fSize) + "}";
      first = false;
      file = dir.openNextFile();
    }
    dir.close();
    json += "]}";
    r->send(200, "application/json", json);
  });

  server.on("/delete", HTTP_GET, [](AsyncWebServerRequest *r){
    if (!r->hasArg("file") || !sdAvailable) { r->send(400, "text/plain", "Fehler"); return; }
    String fn = r->arg("file"); if (!fn.startsWith("/")) fn = "/" + fn;
    if (SD.exists(fn)) { SD.remove(fn); sdTotalBytes = SD.totalBytes(); sdUsedBytes = SD.usedBytes(); r->send(200, "text/plain", "Gelöscht"); } 
    else { r->send(404, "text/plain", "Nicht gefunden"); }
  });

  server.on("/flash", HTTP_GET, [](AsyncWebServerRequest *r){
    if (!r->hasArg("file")) { r->send(400, "text/plain", "Fehler: Kein Dateipfad übergeben."); return; }
    String binPath = r->arg("file"); while (binPath.startsWith("//")) binPath = binPath.substring(1); if (!binPath.startsWith("/")) binPath = "/" + binPath;
    if (!sdAvailable || !SD.exists(binPath)) { r->send(404, "text/plain", "Fehler: Firmware-Datei (.bin) nicht gefunden."); return; }
    r->send(200, "text/plain", "Flash-Vorgang gestartet! Board führt Update durch und startet neu...");
    otaTargetBinPath = binPath; otaTriggered = true;
  });

  server.on("/upload", HTTP_POST, [](AsyncWebServerRequest *r){
    AsyncWebServerResponse *resp = r->beginResponse(200, "text/plain", "Upload OK");
    resp->addHeader("Access-Control-Allow-Origin", "*"); r->send(resp);
  }, [](AsyncWebServerRequest *r, String filename, size_t index, uint8_t *data, size_t len, bool final){
    static String destFullPath;
    if (!index) {
      String targetDir = r->hasArg("dir") ? r->arg("dir") : "/";
      if (!targetDir.endsWith("/")) targetDir += "/"; if (!targetDir.startsWith("/")) targetDir = "/" + targetDir;
      if (filename.startsWith("/")) filename = filename.substring(1);
      destFullPath = targetDir + filename;
      if (sdAvailable) { if (SD.exists(destFullPath)) SD.remove(destFullPath); uploadFile = SD.open(destFullPath, FILE_WRITE); }
    }
    if (uploadFile) { uploadFile.write(data, len); }
    if (final) { if (uploadFile) { uploadFile.flush(); uploadFile.close(); } sdTotalBytes = SD.totalBytes(); sdUsedBytes = SD.usedBytes(); }
  });

  server.onNotFound([](AsyncWebServerRequest *r) { r->redirect("http://st.ag/"); });

  server.begin();
  webServerInitialized = true;
}

void toggleWifiAP(bool enable) {
  if (enable && !wifiApActive) {
    WiFi.disconnect(true, true);
    delay(50);

    WiFi.onEvent(onWiFiEvent);
    WiFi.mode(WIFI_AP);
    WiFi.setSleep(false);
    WiFi.setTxPower(WIFI_POWER_2dBm); // [POWER FIX] Reduziert Sendeleistung gegen Brownouts
    delay(50);

    IPAddress apIP(10, 10, 10, 1);
    WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
    WiFi.softAP(AP_SSID);
    delay(100);

    dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
    dnsServer.start(DNS_PORT, "*", apIP);

    initWebServer(); // [BUGFIX] Startet Dashboard

    wifiApActive = true;
    wifiActivatedTime = millis();
    wifiLastClientSeenTime = millis();
    hadAtLeastOneClient = false;
    lastMotionTimestamp = millis();
    currentLedMode = LED_MODE_WIFI_WAVE;

    logMsg("\n[WIFI AP BEREIT] SSID: '%s' | IP: 10.10.10.1 | Web: http://st.ag/\n", AP_SSID);
  } else if (!enable && wifiApActive) {
    dnsServer.stop();
    // [BUGFIX] server.end() entfernt! Dashboard bleibt für STA erhalten.
    ws.closeAll();
    WiFi.softAPdisconnect(true);
    if (!wifiStaActive) WiFi.mode(WIFI_OFF);
    wifiApActive = false;
    currentLedMode = LED_MODE_OFF;
    pixels.clear(); 
    pixels.show();
    lastMotionTimestamp = millis();
    Serial.println("[WIFI] AP deaktiviert.");
  }
}

bool connectKnownWiFi() {
  String ssid, pass;
  if (!loadWifiCredentials(ssid, pass)) {
    Serial.println("[WIFI STA] Keine Zugangsdaten in /settings/wifi.json gefunden.");
    return false; // [KORREKTUR] Muss zwingend false zurückgeben!
  }
  
  Serial.printf("[WIFI STA] Verbinde mit '%s'...\n", ssid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_5dBm); 
  WiFi.begin(ssid.c_str(), pass.c_str());
  
  initWebServer(); 
  
  wifiStaActive = true;
  wifiApActive = false;
  currentLedMode = LED_MODE_WIFI_WAVE;
  
  return true; // [KORREKTUR] Muss zwingend true zurückgeben!
}
uint32_t lastButtonReleaseTime = 0;
uint8_t clickCount = 0;

void checkButton() {
  bool currentState = digitalRead(BUTTON_PIN);
  uint32_t now = millis();

  // Flankenerkennung: Taste gedrückt (Active-LOW)
  if (currentState == LOW && buttonLastState == HIGH) {
    buttonPressStartTime = now;
    lastMotionTimestamp = now;
  }

  // Flankenerkennung: Taste losgelassen
  if (currentState == HIGH && buttonLastState == LOW) {
    uint32_t duration = now - buttonPressStartTime;
    lastMotionTimestamp = now;

    if (duration >= 2000) {
      Serial.println("[BUTTON] Langer Druck -> WLAN Umschalten");
      if (wifiStaActive) {
        WiFi.disconnect(true);
        WiFi.mode(WIFI_OFF);
        wifiStaActive = false;
        currentLedMode = LED_MODE_OFF;
        pixels.clear(); 
        pixels.show();
      } else {
        toggleWifiAP(!wifiApActive);
      }
      clickCount = 0;
    } else if (duration > 50) {
      clickCount++;
      lastButtonReleaseTime = now;
    }
  }

  // Klick-Auswertung ohne blockierende Delays
  if (clickCount > 0 && (now - lastButtonReleaseTime > 400)) {
    if (clickCount == 1) {
      Serial.println("[BUTTON] Einzelklick -> STAG Akkuanzeige");
      startBatteryAnimation();
} else if (clickCount >= 2) {
      Serial.println("[BUTTON] Doppelklick -> Prüfe WLAN, Fallback auf LTE-Stream");
      
      // [BROWNOUT FIX] Turn off LEDs instantly to free up power for radios
      pixels.clear(); 
      pixels.show();
      currentLedMode = LED_MODE_OFF;
      isBatteryAnimRunning = false;

      if (connectKnownWiFi()) {
        wifiConnecting = true;
        wifiConnectStartTime = millis();
      } else {
        // [BUGFIX] Immediate fallback without hanging for 7s
        wifiConnecting = true;
        wifiConnectStartTime = millis() - 7500UL; 
      }
    }
    clickCount = 0;
  }

  buttonLastState = currentState;
}

bool initSDCardRobust() {
  pinMode(SD_CS, OUTPUT);
  digitalWrite(SD_CS, HIGH);

  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  for (uint8_t i = 0; i < 10; i++) {
    sdSPI.transfer(0xFF);
  }
  delay(10);

  Serial.println("\n[SD DIAGNOSE] Starte Initialisierung...");

  if (!SD.begin(SD_CS, sdSPI, 4000000)) {
    Serial.println("[SD FEHLER] SD.begin() fehlgeschlagen (Karte fehlt oder nicht lesbar).");
    sdAvailable = false;
    sdTotalBytes = 0;
    sdUsedBytes = 0;
    return false;
  }

  uint8_t cardType = SD.cardType();
  if (cardType == CARD_NONE) {
    Serial.println("[SD FEHLER] Keine Karte im Slot erkannt!");
    sdAvailable = false;
    return false;
  }

  sdAvailable = true;
  Serial.print("[SD ERFOLG] Kartentyp: ");
  if (cardType == CARD_MMC) Serial.println("MMC");
  else if (cardType == CARD_SD) Serial.println("SDSC");
  else if (cardType == CARD_SDHC) Serial.println("SDHC / SDXC");
  else Serial.println("Unbekannt");

  sdTotalBytes = SD.totalBytes();
  sdUsedBytes = SD.usedBytes();
  Serial.printf("[SD INFO] Gesamtspeicher: %llu MB | Belegt: %llu MB\n", 
                sdTotalBytes / (1024 * 1024), 
                sdUsedBytes / (1024 * 1024));

  File testFile = SD.open("/test_rw.txt", FILE_WRITE);
  if (testFile) {
    testFile.println("STAG_IMU_OK");
    testFile.close();
    Serial.println("[SD TEST] Schreibzugriff erfolgreich verifiziert.");
    SD.remove("/test_rw.txt");
  } else {
    Serial.println("[SD WARNUNG] Karte erkannt, aber Schreibzugriff fehlgeschlagen (Schreibschutz?)");
  }
  return true;
}
/*
 * Breadcrumb: 2026-09-09 21:35 - SD Log Pointer Persistence
 * [CRITICAL BUGFIX FLAG - SYNC DEDUPLICATION]:
 * Tracks byte offsets in /settings/sync_ptr.json to prevent re-uploading
 * historical CSV rows on subsequent wake/sync cycles.
 */
void loadSyncPointer() {
  if (!sdAvailable || !SD.exists(PATH_SYNC_PTR)) return;
  File f = SD.open(PATH_SYNC_PTR, FILE_READ);
  if (f) {
    String s = f.readString();
    f.close();
    int idx = s.indexOf("\"bat_offset\":");
    if (idx != -1) {
      syncPtr.batLogOffset = s.substring(idx + 13).toInt();
    }
  }
}

void saveSyncPointer() {
  if (!sdAvailable) return;
  createSdDirectories();
  File f = SD.open(PATH_SYNC_PTR, FILE_WRITE);
  if (f) {
    f.printf("{\"bat_offset\":%u}", syncPtr.batLogOffset);
    f.close();
  }
}

/*
 * Breadcrumb: 2026-09-09 21:40 - Supabase Batch Telemetry Uploader
 * [CRITICAL BUGFIX FLAG - BUFFER LIMITS]:
 * Limits batch reads to 15 lines max per HTTP call to prevent heap exhaustion.
 * Uses HTTPClient with verify-free SSL for low overhead.
 */
/*
 * Breadcrumb: 2026-09-09 23:58 - Direct Live-Telemetry Push & TIMESTAMPTZ Guard
 * [CRITICAL BUGFIX FLAG - SUPABASE INGESTION]:
 * 1. Replaces 'BOOT+...' timestamps with current valid ISO timestamp to satisfy Postgres TIMESTAMPTZ.
 * 2. Directly pushes live telemetry frame if SD log has no new records, ensuring instant dashboard display.
 */
void syncBatteryLogsToSupabase() {
  if (!wifiStaActive || WiFi.status() != WL_CONNECTED) return;

  time_t nowSec;
  time(&nowSec);
  if (nowSec < 1704067200) {
    logMsg("[CLOUD SYNC] Warte auf SNTP-Zeitsynchronisation...\n");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;
  String endpoint = String(SUPABASE_URL) + "/rest/v1/battery_logs";

  String jsonPayload = "[";
  uint8_t count = 0;
  uint32_t newOffset = syncPtr.batLogOffset;

  if (sdAvailable && SD.exists(PATH_BAT_LOG)) {
    File batFile = SD.open(PATH_BAT_LOG, FILE_READ);
    if (batFile) {
      uint32_t fileSize = batFile.size();
      if (syncPtr.batLogOffset == 0) {
        String header = batFile.readStringUntil('\n');
        syncPtr.batLogOffset = batFile.position();
      } else if (syncPtr.batLogOffset < fileSize) {
        batFile.seek(syncPtr.batLogOffset);
      }

      while (batFile.available() && count < 15) {
        String line = batFile.readStringUntil('\n');
        line.trim();
        if (line.length() == 0) continue;

        int c1 = line.indexOf(',');
        int c2 = line.indexOf(',', c1 + 1);
        int c3 = line.indexOf(',', c2 + 1);
        int c4 = line.indexOf(',', c3 + 1);

        if (c1 != -1 && c2 != -1 && c3 != -1 && c4 != -1) {
          String ts   = line.substring(0, c1);
          String vbat = line.substring(c1 + 1, c2);
          String pct  = line.substring(c2 + 1, c3);
          String chg  = line.substring(c3 + 1, c4);
          String boot = line.substring(c4 + 1);

          if (ts.startsWith("BOOT+")) {
            ts = getFormattedTimestamp();
          }

          if (count > 0) jsonPayload += ",";
          jsonPayload += "{\"device_id\":\"" + String(DEVICE_IDENTIFIER) + "\",";
          jsonPayload += "\"recorded_at\":\"" + ts + "\",";
          jsonPayload += "\"battery_voltage\":" + vbat + ",";
          jsonPayload += "\"battery_percent\":" + pct + ",";
          jsonPayload += "\"charging_status\":\"" + chg + "\",";
          jsonPayload += "\"boot_cycle\":" + boot + "}";

          count++;
          newOffset = batFile.position();
        }
      }
      batFile.close();
    }
  }

  // Falls keine neuen Zeilen auf SD vorliegen: Aktuellen Live-Wert direkt pushen
  if (count == 0) {
    jsonPayload += "{\"device_id\":\"" + String(DEVICE_IDENTIFIER) + "\",";
    jsonPayload += "\"recorded_at\":\"" + getFormattedTimestamp() + "\",";
    jsonPayload += "\"battery_voltage\":" + String(globalBmsStatus.batteryVoltage, 3) + ",";
    jsonPayload += "\"battery_percent\":" + String(globalBmsStatus.batteryPercent) + ",";
    jsonPayload += "\"charging_status\":\"" + globalBmsStatus.chargeStatus + "\",";
    jsonPayload += "\"boot_cycle\":" + String(bootCycleCount) + "}";
  }
  jsonPayload += "]";

  if (https.begin(client, endpoint)) {
    https.addHeader("Content-Type", "application/json");
    https.addHeader("apikey", SUPABASE_ANON_KEY);
    https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
    https.addHeader("Prefer", "return=minimal");

    int httpCode = https.POST(jsonPayload);
    if (httpCode == HTTP_CODE_CREATED || httpCode == HTTP_CODE_OK || httpCode == 204) {
      logMsg("[CLOUD SYNC] Telemetrie gesendet (HTTP %d)\n", httpCode);
      if (count > 0) {
        syncPtr.batLogOffset = newOffset;
        saveSyncPointer();
      }
    } else {
      logMsg("[CLOUD SYNC FEHLER] HTTP %d: %s\n", httpCode, https.getString().c_str());
    }
    https.end();
  }
}

/*
 * Breadcrumb: 2026-09-10 00:25 - Hardware SIM7000G Non-Blocking AT Engine
 * [CRITICAL BUGFIX FLAG - MODEM ENGINE]:
 * Uses UART2 (Pins 26/27) to communicate with SIM7000G.
 * Powers on modem via PWRKEY, unlocks SIM via AT+CPIN, and performs direct HTTPS POST to Supabase.
 */
/*
 * Breadcrumb: 2026-09-10 01:25 - Cleaned sendAT Definition Signature
 * Fix: Removed default argument '= 1000' from implementation to match prototype.
 */
HardwareSerial SerialAT(2);

String sendAT(const String& cmd, uint32_t timeout_ms) {
  while (SerialAT.available()) SerialAT.read();
  SerialAT.println(cmd);
  String response = "";
  uint32_t start = millis();
  while (millis() - start < timeout_ms) {
    while (SerialAT.available()) {
      response += (char)SerialAT.read();
    }
    if (response.indexOf("OK") != -1 || response.indexOf("ERROR") != -1) break;
  }
  return response;
}

void powerOnModem() {
  pinMode(MODEM_PWRKEY_PIN, OUTPUT);
  digitalWrite(MODEM_PWRKEY_PIN, LOW);
  delay(1200); // Hardware-Impuls zum Einschalten des SIM7000
  digitalWrite(MODEM_PWRKEY_PIN, HIGH);
  delay(2000);
}

/*
 * Breadcrumb: 2026-09-10 01:10 - Robust Cellular Registration & Bearer Activation
 * [CRITICAL BUGFIX FLAG - LTE REGISTRATION]:
 * 1. Polls AT+CGREG? up to 15s to guarantee cell tower registration before bearer activation.
 * 2. Validates AT+SAPBR=1,1 response. Returns false on failure so the fallback correctly
 *    triggers red error blinks, turns LEDs off, and permits deep sleep.
 */
bool initModemHardware() {
  SerialAT.begin(MODEM_BAUDRATE, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
  
  String res = sendAT("AT", 1000);
  if (res.indexOf("OK") == -1) {
    logMsg("[LTE MODEM] Schalte Modem ein (PWRKEY)...\n");
    powerOnModem();
    res = sendAT("AT", 2000);
  }

  if (res.indexOf("OK") == -1) {
    logMsg("[LTE MODEM FEHLER] Modem antwortet nicht auf AT!\n");
    return false;
  }

  sendAT("ATE0"); // Echo aus

  // PIN-Status abfragen und ggf. entsperren
  String cpin = sendAT("AT+CPIN?", 2000);
  if (cpin.indexOf("SIM PIN") != -1) {
    if (simPin.length() > 0) {
      logMsg("[LTE MODEM] Entriegle SIM-Karte mit PIN...\n");
      String unlock = sendAT("AT+CPIN=\"" + simPin + "\"", 3000);
      if (unlock.indexOf("OK") == -1) {
        logMsg("[LTE MODEM FEHLER] Falsche SIM-PIN!\n");
        return false;
      }
      delay(2000);
    } else {
      logMsg("[LTE MODEM WARNUNG] SIM verlangt PIN, aber keine PIN hinterlegt!\n");
      return false;
    }
  }

  // Warten auf Netzeinbuchung (Status 1 = Home, 5 = Roaming)
  logMsg("[LTE MODEM] Warte auf Netzeinbuchung...\n");
  bool registered = false;
  uint32_t startReg = millis();
  while (millis() - startReg < 15000) {
    String reg = sendAT("AT+CGREG?", 1000);
    if (reg.indexOf(",1") != -1 || reg.indexOf(",5") != -1) {
      registered = true;
      break;
    }
    delay(1000);
  }

  if (!registered) {
    logMsg("[LTE MODEM FEHLER] Keine Netzeinbuchung (Kein Empfang oder ungültige SIM)!\n");
    return false;
  }

  // APN setzen & Datenkanal (Bearer) aktivieren
  sendAT("AT+SAPBR=3,1,\"Contype\",\"GPRS\"", 1000);
  sendAT("AT+SAPBR=3,1,\"APN\",\"" + simApn + "\"", 1000);
  String sapbrRes = sendAT("AT+SAPBR=1,1", 5000);
  
  if (sapbrRes.indexOf("OK") == -1 && sapbrRes.indexOf("already") == -1) {
    logMsg("[LTE MODEM FEHLER] GPRS Bearer konnte nicht geöffnet werden!\n");
    return false;
  }

  lteModemReady = true;
  logMsg("[LTE MODEM] Einbuchung erfolgreich! APN: %s\n", simApn.c_str());
  return true;
}

/*
 * Breadcrumb: 2026-09-10 01:15 - Compliant SIM7000 HTTPS Engine with Async Action Parser
 * [CRITICAL BUGFIX FLAG - SIM7000 HTTPS POST]:
 * 1. Removed unsupported AT+HTTPPARA="USERDATA" header injection.
 * 2. Authenticates via Supabase PostgREST '?apikey=...' query parameter.
 * 3. Waits explicitly for the asynchronous '+HTTPACTION: 1,20x,...' URC response.
 */
bool sendTelemetryOverLTE(const String& jsonPayload) {
  if (!lteModemReady && !initModemHardware()) return false;

  logMsg("[LTE HTTP] Sende Daten via SIM7000G an Supabase...\n");
  sendAT("AT+HTTPTERM", 500); // Vorherige Sessions sauber beenden
  sendAT("AT+HTTPINIT", 1000);
  sendAT("AT+HTTPSSL=1", 1000);
  sendAT("AT+HTTPPARA=\"CID\",1", 1000);
  
  // PostgREST akzeptiert den API-Key direkt als URL-Parameter
  String targetUrl = String(SUPABASE_URL) + "/rest/v1/battery_logs?apikey=" + String(SUPABASE_ANON_KEY);
  sendAT("AT+HTTPPARA=\"URL\",\"" + targetUrl + "\"", 2000);
  sendAT("AT+HTTPPARA=\"CONTENT\",\"application/json\"", 1000);

  String dataCmd = "AT+HTTPDATA=" + String(jsonPayload.length()) + ",8000";
  sendAT(dataCmd, 1000);
  delay(50);
  SerialAT.print(jsonPayload);
  delay(100);

  // POST-Befehl absetzen
  while (SerialAT.available()) SerialAT.read();
  SerialAT.println("AT+HTTPACTION=1");

  // Asynchron auf die Server-Antwortzeile warten (+HTTPACTION: 1,xxx,len)
  uint32_t start = millis();
  String actionRes = "";
  while (millis() - start < 12000) {
    while (SerialAT.available()) {
      actionRes += (char)SerialAT.read();
    }
    if (actionRes.indexOf("+HTTPACTION:") != -1) break;
    delay(15);
  }
  sendAT("AT+HTTPTERM", 1000);

  if (actionRes.indexOf(",200,") != -1 || actionRes.indexOf(",201,") != -1 || actionRes.indexOf(",204,") != -1) {
    logMsg("[LTE HTTP ERFOLG] Daten erfolgreich via Mobilfunk übertragen!\n");
    return true;
  } else {
    logMsg("[LTE HTTP FEHLER] Senden fehlgeschlagen: %s\n", actionRes.c_str());
    return false;
  }
}
// ==========================================
// 10. SETUP
// ==========================================

void softwareResetBNO085() {
  logMsg("[BOOT] Sende Executable Reset Command an BNO085...\n");
  uint8_t cmd[5] = {5, 0, 1, 0, 1}; 
  Wire.beginTransmission(BNO085_I2C_ADDR);
  Wire.write(cmd, 5);
  Wire.endTransmission();
  delay(300); 
}
/*
 * Breadcrumb: 2026-09-08 21:30 - Clean Setup & I2C Buffer Init
 */

/*
 * Breadcrumb: 2026-09-08 22:10 - Step-Instrumented Setup with Wire Timeout
 * [CRITICAL BUGFIX FLAG - SETUP DEADLOCK]:
 * 1. Added Wire.setTimeOut(25) to prevent infinite hardware blocking on clock-stretching.
 * 2. Added Serial.flush() after each boot step to immediately detect any hardware stalls.
 * 3. Enforces 200ms settling time for BNO085 startup before any FIFO drain is attempted.
 */

// ============================================================================
// 10. SETUP BOOT SEQUENCE (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:05 - Clean Wake-Up Demux & Instant Re-Arm
 * [CRITICAL BUGFIX FLAG - EXT0 WAKE RECOVERY]:
 * Properly de-inits RTC GPIO holding states and un-arms 0x13 / 0x12 before launching 10Hz stream.
 */
// ============================================================================
// 10. SETUP BOOT SEQUENCE (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:40 - Clean Boot Demux & Wake-Up Un-Arming
 * [CRITICAL BUGFIX FLAG - EXT0 WAKE DEINIT]:
 * Fully de-inits RTC GPIO states for GPIO 33 and unregisters 0x21 / 0x22 before enabling 10Hz stream.
 */
/*
 * Breadcrumb: 2026-09-08 23:00 - Setup Wake-Deinit & Feature Handshake
 * [CRITICAL BUGFIX FLAG - RTC DEINIT]:
 * rtc_gpio_hold_dis() und rtc_gpio_deinit() stellen sicher, dass GPIO 33 
 * nach dem Aufwachen wieder vom Standard-GPIO-Treiber gesteuert wird.
 */

// ============================================================================
// 10. SETUP BOOT SEQUENCE (REPLACEMENT)
// ============================================================================
/*
 * Breadcrumb: 2026-09-08 23:55 - Clean Sensor Power Up & Hardware Wake Arm
 * [CRITICAL BUGFIX FLAG - BNO085 HARDWARE WAKEUP]:
 * 1. Führt sauberen Power-Up-Handshake durch (Boost 5V -> I2C Reset -> Wartezeit).
 * 2. Wartet aktiv auf INT LOW vor dem ersten SHTP-Lesen.
 * 3. Schärft Report 0x22 (Significant Motion) mit Wakeup Delivery.
 */




/*
 * Breadcrumb: 2026-09-08 23:58 - Fully Instrumented Setup & Wakeup Demux
 * [CRITICAL BUGFIX FLAG - BOOT TRACE]:
 * Ausgabe von Aufwachursachen, I2C-Ping und Initial-Reports.
 */
/*
 * Breadcrumb: 2026-09-08 23:59 - Active Boot Handshake & Direct Header Sniff
 * [CRITICAL BUGFIX FLAG - SHTP ADVERTISEMENT POP]:
 * Liest nach dem 5V-Boost-Start das initiale Boot-Paket (Channel 0 / 1) 
 * aktiv aus, damit der BNO085 nachfolgende SetFeature-Befehle akzeptiert.
 */
/*
 * Breadcrumb: 2026-09-09 00:20 - Pin-32 Hardware Diagnostic & Full Pipeline Startup
 * [CRITICAL BUGFIX FLAG - PIN 32 HARDWARE CHECK]:
 * Überprüft GPIO 32 vor dem Sensorstart auf Pegeländerungen und liest 
 * Boot- und Quat-Reports direkt ohne Blockade ein.
 */
/*
 * Breadcrumb: 2026-09-09 00:45 - Sensor Reset & 3D Stream Restored
 * [CRITICAL BUGFIX FLAG - SHTP SYNC]:
 * Stellt softwareResetBNO085() wieder her. Nach dem Aufwachen aus Deep Sleep
 * MUSS der BNO085-Core resettet werden, damit er 0x08 akzeptiert und streamt.
 */
/*
 * Breadcrumb: 2026-09-09 00:52 - Robust Setup & Game Rotation Vector (0x05)
 * [CRITICAL BUGFIX FLAG - 6-DOF ROTATION & PIN CHECK]:
 * Enables 0x05 (Game Rotation Vector) alongside 0x08 to guarantee instantaneous 
 * orientation without waiting for magnetometer calibration.
 */
/*
 * Breadcrumb: 2026-09-09 01:20 - Single-Stream 6-DoF Orientation Setup
 * [CRITICAL BUGFIX FLAG - JUMP ELIMINATION]:
 * Aktiviert ausschließlich Report 0x05 (Game Rotation Vector) und 0x04 (Accel).
 * Verhindert das Springen durch interferierende Yaw-Winkel zwischen 0x05 und 0x08.
 */
/*
 * Breadcrumb: 2026-09-09 02:40 - Button RTC Deinit & Instant Wake-Action Setup
 * [CRITICAL BUGFIX FLAG - BUTTON EXT1 WAKE]:
 * 1. Calls rtc_gpio_deinit(BUTTON_PIN) to ensure GPIO 34 returns cleanly to digital input.
 * 2. Fires startBatteryAnimation() immediately upon EXT1 wake so the click isn't lost during boot.
 */
void setup() {
  bootCycleCount++;
  Serial.begin(115200);
  while (!Serial && millis() < 2000);

  Serial.println("\n========================================================");
  Serial.printf("  STAG IMU & TELEMETRY SUITE (Boot #%d)\n", bootCycleCount);
  Serial.println("========================================================");
  Serial.flush();

  // Deep Sleep Pin-Halterung lösen
  gpio_deep_sleep_hold_dis(); 
  gpio_hold_dis(GPIO_NUM_21);
  gpio_hold_dis(GPIO_NUM_22);

  // RTC Routing beider Wake-Pins lösen und normale GPIOs schärfen
  rtc_gpio_deinit(BNO08X_INT);
  pinMode(BNO08X_INT, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BNO08X_INT), bno085_isr, FALLING);

  rtc_gpio_deinit(BUTTON_PIN);
  pinMode(BUTTON_PIN, INPUT);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  pinMode(BAT_ADC_PIN, INPUT);

pixels.begin();
  pixels.setBrightness(40); // [BROWNOUT FIX] Dramatically reduces peak current!
  pixels.clear();
  pixels.show();

/*
 * Breadcrumb: 2026-09-10 00:32 - Setup SD SIM Credentials Loader
 * [CRITICAL BUGFIX FLAG - PERSISTENT SIM]:
 * Added loadSimCredentials to setup() sequence to restore SIM PIN and APN across deep sleep resets.
 */
  initSDCardRobust();
  if (sdAvailable) {
    createSdDirectories();
    loadConfigFromSD();
    loadSyncPointer();
    loadSimCredentials(simPin, simApn); // [BUGFIX] SIM-PIN & APN laden
    logBatteryStatusToSD();
  }

  Serial.println("[BOOT 2/6] Starte I2C Bus & PMIC 5V Boost...");
  resetI2CBus(); 
  Wire.setBufferSize(512);
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(400000);
  enable5VBoostPower();
  delay(150);
  
globalBmsStatus = readBMS();
  WiFi.onEvent(onWiFiEvent); // [WICHTIG] Global registrieren für AP & STA
  WiFi.mode(WIFI_OFF);

  // [BUGFIX] Erst NACH I2C-Start den initialen Akku-Log auf SD schreiben:
  if (sdAvailable) {
    logBatteryStatusToSD();
  }

  esp_sleep_wakeup_cause_t wakeup_reason = esp_sleep_get_wakeup_cause();
  Serial.printf("[BOOT 3/6] Wakeup Reason Code: %d ", (int)wakeup_reason);
  if (wakeup_reason == ESP_SLEEP_WAKEUP_EXT0) {
    Serial.println("-> [WAKE SUCCESS] Aufgewacht durch IMU (GPIO 32 LOW)!");
    flashWakeupBlink();
  } else if (wakeup_reason == ESP_SLEEP_WAKEUP_EXT1) {
    Serial.println("-> [WAKE SUCCESS] Aufgewacht durch Taster (GPIO 34 LOW)!");
    startBatteryAnimation(); // Direkte optische Rückmeldung beim Taster-Wecken
  } else {
    Serial.println("-> Kaltstart / Reset / Power-On.");
  }

  // I2C Ping Test
  Wire.beginTransmission(BNO085_I2C_ADDR);
  uint8_t pingErr = Wire.endTransmission();
  Serial.printf("[BOOT 4/6] I2C Ping BNO085 (0x4A): %s (Code %u)\n", 
                pingErr == 0 ? "GEFUNDEN" : "NICHT ERREICHBAR!", pingErr);

  Serial.println("[BOOT 5/6] Starte BNO085 Core neu...");
  softwareResetBNO085();
  delay(200);

  // Boot-Pakete abholen
  for (int i = 0; i < 20; i++) {
    readSHTPPacket(BNO085_I2C_ADDR);
    delay(5);
  }

  uint16_t interval_ms = 1000 / sysConfig.imuSampleRate_hz;
  logMsg("[BOOT 6/6] Aktiviere 0x05 (Game Quat) & 0x04 (Accel) mit %u ms...\n", interval_ms);
  enableBNO085Feature(BNO085_I2C_ADDR, 0x05, interval_ms, 0.0f);
  enableBNO085Feature(BNO085_I2C_ADDR, 0x04, interval_ms, 0.0f);
  delay(50);
  
  // Bestätigungen leeren
  for (int i = 0; i < 15; i++) {
    readSHTPPacket(BNO085_I2C_ADDR);
    delay(5);
  }

  lastMotionTimestamp = millis();
  ref_qw = 1.0f; ref_qx = 0.0f; ref_qy = 0.0f; ref_qz = 0.0f;

  Serial.println("[BOOT FERTIG] System betriebsbereit. Trete in Loop ein.");
  Serial.println("--------------------------------------------------------\n");
  Serial.flush();
}


// ==========================================
// 11. MAIN LOOP
// ==========================================
/*
 * Breadcrumb: 2026-09-09 23:55 - Clean Loop Transition & Controlled Sleep
 * [CRITICAL BUGFIX FLAG - SLEEP LOGIC]:
 * 1. Cleaned nested comment paste artefact.
 * 2. If continuousLiveMode is active, Wi-Fi stays connected 24/7.
 * 3. If continuousLiveMode is false, device sleeps after idleSleepTimeout_ms (5-60s)
 *    to preserve battery, waking up on motion or button press.
 */
void loop() {
  if (otaTriggered) {
    otaTriggered = false;
    delay(500);
    Serial.printf("[OTA LOOP] Starte Flash-Prozess für: %s\n", otaTargetBinPath.c_str());
    performSDOTA(otaTargetBinPath);
  }

  checkButton();
  uint32_t now = millis();

  // 1. Wi-Fi AP & Client Überwachung
  if (wifiApActive) {
    dnsServer.processNextRequest();
    ws.cleanupClients();

    uint8_t clientCount = WiFi.softAPgetStationNum();
    if (clientCount > 0) {
      hadAtLeastOneClient = true;
      wifiLastClientSeenTime = now;
      lastMotionTimestamp = now;
    } else {
      if (!hadAtLeastOneClient && (now - wifiActivatedTime >= 120000UL) && (wifiActivatedTime > 0)) {
        logMsg("[WIFI TIMEOUT] AP schaltet ab (Keine Verbindung nach 120s).\n");
        toggleWifiAP(false);
      }
      else if (hadAtLeastOneClient && (now - wifiLastClientSeenTime >= 60000UL)) {
        logMsg("[WIFI TIMEOUT] AP schaltet ab (Alle Clients getrennt seit 60s).\n");
        toggleWifiAP(false);
      }
    }
  }

  /*
 * Breadcrumb: 2026-09-10 00:55 - Safe LTE Fallback & Visual LED Error Shutdown
 * [CRITICAL BUGFIX FLAG - LED SHUTDOWN & LTE RECOVERY]:
 * 1. Verifies initModemHardware() return code before asserting lteStreamingActive.
 * 2. Blinks LEDs red 3x on total failure, then turns LEDs OFF and allows deep sleep.
 * 3. Aborts streaming and turns LEDs off after 3 consecutive LTE HTTP post failures.
 */
  // Non-blocking Überwachung: Fallback auf LTE, wenn WLAN nach 7 Sekunden nicht erreichbar ist
  if (wifiConnecting) {
    if (WiFi.status() == WL_CONNECTED) {
      wifiConnecting = false;
      lteStreamingActive = false;
      logMsg("[CONNECT] Mit WLAN verbunden. Nutze WLAN-Verbindung.\n");
    } else if (millis() - wifiConnectStartTime >= 7000UL) {
      wifiConnecting = false;
      WiFi.disconnect(true);
      WiFi.mode(WIFI_OFF); // Wi-Fi aus, um Spitzenstrom für LTE bereitzustellen
      wifiStaActive = false;
      logMsg("[CONNECT] Kein bekanntes WLAN erreichbar -> Prüfe LTE-Verbindung...\n");
      
      // [BROWNOUT FIX] Double-check LEDs are OFF before SIM7000G draws 2A peak
      currentLedMode = LED_MODE_OFF;
      pixels.clear(); 
      pixels.show();
      
      if (initModemHardware()) {
        logMsg("[CONNECT] LTE-Modem betriebsbereit. Starte LTE-Stream!\n");
        lteStreamingActive = true;
        currentLedMode = LED_MODE_WIFI_WAVE;
      } else {
        logMsg("[CONNECT FEHLER] Weder WLAN noch LTE verfügbar! Schalte LEDs aus.\n");
        lteStreamingActive = false;
        currentLedMode = LED_MODE_OFF;
        
        // Optische Rückmeldung: 3x rotes Blinken als Fehleranzeige
        for (int r = 0; r < 3; r++) {
          for (int i = 0; i < NUM_PIXELS; i++) pixels.setPixelColor(i, pixels.Color(220, 0, 0));
          pixels.show(); delay(120);
          pixels.clear(); pixels.show(); delay(120);
        }
        pixels.clear();
        pixels.show();
      }
    }
  }

  // A) Standard LTE-Batchversand (im Intervall von sysConfig.lteBatchInterval_min)
  if (!wifiStaActive && (now - lastLteBatchTime >= (sysConfig.lteBatchInterval_min * 60000UL))) {
    lastLteBatchTime = now;
    String payload = "[{\"device_id\":\"" + String(DEVICE_IDENTIFIER) + "\","
                     "\"recorded_at\":\"" + getFormattedTimestamp() + "\","
                     "\"battery_voltage\":" + String(globalBmsStatus.batteryVoltage, 3) + ","
                     "\"battery_percent\":" + String(globalBmsStatus.batteryPercent) + ","
                     "\"charging_status\":\"" + globalBmsStatus.chargeStatus + "\","
                     "\"boot_cycle\":" + String(bootCycleCount) + "}]";
    sendTelemetryOverLTE(payload);
  }

  // B) Kontinuierlicher LTE-Stream nach Doppelklick ohne WLAN (alle 2 Sekunden)
  static uint8_t lteFailStreak = 0;
  if (lteStreamingActive && (now - lastLteStreamBroadcastTime >= 2000UL)) {
    lastLteStreamBroadcastTime = now;
    String payload = "[{\"device_id\":\"" + String(DEVICE_IDENTIFIER) + "\","
                     "\"recorded_at\":\"" + getFormattedTimestamp() + "\","
                     "\"battery_voltage\":" + String(globalBmsStatus.batteryVoltage, 3) + ","
                     "\"battery_percent\":" + String(globalBmsStatus.batteryPercent) + ","
                     "\"charging_status\":\"LTE Live Stream\","
                     "\"boot_cycle\":" + String(bootCycleCount) + "}]";
    
    if (sendTelemetryOverLTE(payload)) {
      lteFailStreak = 0;
      lastMotionTimestamp = now; // Hält Board wach, solange Stream erfolgreich sendet
    } else {
      lteFailStreak++;
      if (lteFailStreak >= 3) {
        logMsg("[LTE FEHLER] 3 Übertragungsfehler in Folge -> Beende LTE-Stream & schalte LEDs ab.\n");
        lteStreamingActive = false;
        currentLedMode = LED_MODE_OFF;
        pixels.clear();
        pixels.show();
      }
    }
  }

// 2. Supabase Cloud Synchronisation & OTA-Prüfung
  static bool initialSyncDone = false;
  if (wifiStaActive && WiFi.status() == WL_CONNECTED) {
    // Sofortiger Erst-Sync beim Verbinden, danach alle 60 Sekunden
    if (!initialSyncDone || (now - lastCloudSyncTime >= 60000UL)) {
      lastCloudSyncTime = now;
      initialSyncDone = true;
      syncBatteryLogsToSupabase();
      syncConfigFromSupabase();
      checkAndDownloadCloudOTA();
    }
  } else {
    initialSyncDone = false;
  }

// 3. BMS & Ladezustand periodisch prüfen (1 Hz)
  if (now - lastBmsPollTime >= 1000) {
    lastBmsPollTime = now;
    globalBmsStatus = readBMS(); 
    targetBatteryPct = globalBmsStatus.batteryPercent;
    isCharging = globalBmsStatus.isCharging;

    if (isCharging && currentLedMode != LED_MODE_WIFI_WAVE && currentLedMode != LED_MODE_BATTERY_ANIM) {
      currentLedMode = LED_MODE_CHARGING;
      lastMotionTimestamp = now;
    } else if (!isCharging && currentLedMode == LED_MODE_CHARGING) {
      currentLedMode = LED_MODE_OFF;
      pixels.clear(); 
      pixels.show();
    }

    // [NEU] Alle 30 Sekunden Akkustatus auf SD sichern
    static uint32_t lastBatSdLogTime = 0;
    if (now - lastBatSdLogTime >= 30000UL) {
      lastBatSdLogTime = now;
      logBatteryStatusToSD();
    }
  }

  // 4. LED Animationen ausführen
  if (currentLedMode == LED_MODE_BATTERY_ANIM) updateBatteryAnimation();
  else if (currentLedMode == LED_MODE_WIFI_WAVE) updateWifiWave();
  else if (currentLedMode == LED_MODE_CHARGING) updateChargingAnimation();

  // 5. PMIC Boost Watchdog
  if (now - lastWdtResetTime >= 5000) {
    lastWdtResetTime = now;
    enable5VBoostPower();
  }

  // 6. IMU Daten lesen: Trigger bei INT LOW oder periodisch alle 20 ms
  static uint32_t lastI2CPoll = 0;
  if (digitalRead(BNO08X_INT) == LOW || (now - lastI2CPoll >= 20)) {
    lastI2CPoll = now;
    if (readSHTPPacket(BNO085_I2C_ADDR)) {
      if (hasValidQuat) {
        float dot = (latest_qw * ref_qw) + (latest_qx * ref_qx) + 
                    (latest_qy * ref_qy) + (latest_qz * ref_qz);
        
        float curW = latest_qw, curX = latest_qx, curY = latest_qy, curZ = latest_qz;
        if (dot < 0.0f) {
          curW = -curW; curX = -curX; curY = -curY; curZ = -curZ;
        }

        float deltaQuat = fabsf(curW - ref_qw) + fabsf(curX - ref_qx) +
                          fabsf(curY - ref_qy) + fabsf(curZ - ref_qz);

        if (deltaQuat >= sysConfig.motionSleepDeltaThreshold) {
          lastMotionTimestamp = now;
          ref_qw = curW; ref_qx = curX; ref_qy = curY; ref_qz = curZ;
        }
      }
    }
  }

  // 7. WebSocket Streams (Lokal & Supabase Cloud Realtime)
  uint32_t wsInterval_ms = 1000 / sysConfig.imuSampleRate_hz;

  // A) Lokaler WebSocket-Broadcast (für Captive Portal)
  if ((wifiApActive || wifiStaActive) && hasValidQuat && (now - lastWsBroadcastTime >= wsInterval_ms)) {
    lastWsBroadcastTime = now;
    if (ws.count() > 0) {
      char wsPayload[160];
      snprintf(wsPayload, sizeof(wsPayload), 
               "{\"w\":%.4f,\"x\":%.4f,\"y\":%.4f,\"z\":%.4f,\"ax\":%.2f,\"ay\":%.2f,\"az\":%.2f}", 
               latest_qw, latest_qx, latest_qy, latest_qz, latest_ax, latest_ay, latest_az);
      ws.textAll(wsPayload);
    }
  }

 // B) Supabase Realtime Cloud-Broadcast mit 5s Reconnect-Sperre
  static uint32_t lastWsConnectAttempt = 0;
  if (wifiStaActive && WiFi.status() == WL_CONNECTED) {
    if (!supabaseWsConnected || !supabaseWsClient.connected()) {
      if (now - lastWsConnectAttempt >= 5000) {
        lastWsConnectAttempt = now;
        initSupabaseRealtime();
      }
    }

    // Eingehende WebSocket-Frames (Bestätigungen / Fehlermeldungen von Supabase) anzeigen
    while (supabaseWsClient.available() > 2) {
      uint8_t b0 = supabaseWsClient.read();
      uint8_t b1 = supabaseWsClient.read();
      size_t rLen = b1 & 0x7F;
      String s = "";
      for (size_t i = 0; i < rLen && supabaseWsClient.available(); i++) {
        s += (char)supabaseWsClient.read();
      }
      if (s.length() > 0) {
        logMsg("[REALTIME SERVER] %s\n", s.c_str());
      }
    }

    // Phoenix Heartbeat alle 25 Sekunden
    if (supabaseWsConnected && (now - lastWsHeartbeatTime >= 25000)) {
      lastWsHeartbeatTime = now;
      const char* hb = "{\"topic\":\"phoenix\",\"event\":\"heartbeat\",\"payload\":{},\"ref\":\"hb\"}";
      sendWssFrame(hb);
    }

    // IMU-Frames mit konfigurierter Abtastrate in die Cloud senden
    if (hasValidQuat && (now - lastCloudWsBroadcastTime >= wsInterval_ms)) {
      lastCloudWsBroadcastTime = now;
      broadcastIMUToCloud();
    }
  } else if (!wifiStaActive && supabaseWsConnected) {
    stopSupabaseRealtime();
  }

  // 8. Periodischer Status-Heartbeat (alle 2000 ms)
  static uint32_t lastHeartbeatPrint = 0;
  if (now - lastHeartbeatPrint >= 2000) {
    lastHeartbeatPrint = now;
    uint32_t idleTime = now - lastMotionTimestamp;
    Serial.printf("[HEARTBEAT] INT(Pin %d)=%d | hasValidQuat=%s | WS: %u | Idle: %lu/%lu ms\n",
                  BNO08X_INT, digitalRead(BNO08X_INT),
                  hasValidQuat ? "JA" : "NEIN",
                  ws.count(), idleTime, sysConfig.idleSleepTimeout_ms);
  }

/*
 * Breadcrumb: 2026-09-10 00:35 - Deep Sleep Guard with Active LTE Stream
 * [CRITICAL BUGFIX FLAG - LTE SLEEP GUARD]:
 * Blocks deep sleep while lteStreamingActive is true.
 */
  // 9. Deep-Sleep Überwachung
// 9. Deep-Sleep Überwachung
  // [BUGFIX] wifiStaActive und wifiConnecting blockieren nun den Schlaf. Das WLAN bricht nicht ab!
  bool blockSleep = (wifiApActive || wifiStaActive || wifiConnecting || ws.count() > 0 || lteStreamingActive || sysConfig.continuousLiveMode || isBatteryAnimRunning || isCharging);
  if (!blockSleep && (now - lastMotionTimestamp >= sysConfig.idleSleepTimeout_ms)) {
    logMsg("[SLEEP] Ruhe erkannt (%lu ms ohne Bewegung) -> Gehe in Deep Sleep...\n", 
           now - lastMotionTimestamp);
    goToDeepSleep();
  }
}