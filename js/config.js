/*
 * Breadcrumb: 2026-09-13 09:30 - Global Configuration & Multi-Device Runtime State
 * [CRITICAL BUGFIX FLAG - MULTI-DEVICE SUPPORT]:
 * 1. Global selectedDeviceId state manages dynamic routing between STAG-IMU-01 and STAG-IMU-02.
 * 2. Centralized Supabase credentials and shared runtime variables.
 */

const SUPABASE_URL = "https://fajwusnwfywfebyffxtf.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhand1c253Znl3ZmVieWZmeHRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5NzYxMjcsImV4cCI6MjEwNDU1MjEyN30.Yt-COlgIh5TySB01EGrdddrZguxW30cwhCeXdMjQ0aM";
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Multi-Device Zustand
let selectedDeviceId = "STAG-IMU-01";
let liveModeActive = false;

// Cloud SD & Command Engine Zustand
let currentCloudSdDir = '/';
let cloudCmdChannel = null;
let liveChannel = null;
let activeCommandId = null;
let activeCommandPollTimer = null;

// Geteilte Telemetrie-Puffer (für 3D und Oszilloskop)
const accHistory = [];
const maxAccPoints = 1800; // 180 s Puffer bei 10 Hz
let curAx = 0, curAy = 0, curAz = 0;
let qw = 1, qx = 0, qy = 0, qz = 0;
let lastQw = 1, lastQx = 0, lastQy = 0, lastQz = 0;
let graphNeedsRedraw = false;