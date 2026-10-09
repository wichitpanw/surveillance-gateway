using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Windows.Markup;

namespace SurveillanceGateway.Client.Services;

/// <summary>
/// Every piece of text this client shows, in English and Thai.
///
/// One table rather than .resx satellite assemblies: two languages, a few hundred strings, and a
/// switch that has to take effect while the app is running - `Thread.CurrentUICulture` plus
/// resource lookups would need the window rebuilt to change, which loses the wall a person has
/// just arranged.
///
/// English is the default. A machine handed to someone who does not read Thai must be usable out
/// of the box, and the operator picks Thai once from the settings dialog if they want it.
///
/// Strings live here and nowhere else. A literal left in a view is a string that quietly stays
/// English (or stays Thai) forever, and nothing catches it.
/// </summary>
public sealed class Strings : INotifyPropertyChanged
{
    public static Strings Current { get; } = new();

    private string _language = "en";

    private static readonly Dictionary<string, (string En, string Th)> Table = new()
    {
        // สถานะการเชื่อมต่อวิดีโอ
        ["video.connecting"] = ("Connecting", "กำลังเชื่อมต่อ"),
        ["video.streamError"] = ("Stream error", "สตรีมผิดพลาด"),
        ["video.streamEnded"] = ("Stream ended", "สตรีมสิ้นสุด"),
        ["video.noPicture"] = ("No picture", "ยังไม่มีภาพ"),
        ["video.noUrl"] = ("No playable URL", "ไม่มี URL สำหรับเล่นภาพ"),
        ["video.openFailed"] = ("Cannot open stream", "เปิดสตรีมไม่สำเร็จ"),
        ["video.unavailable"] = ("Stream unavailable", "สตรีมไม่พร้อมใช้งาน"),
        ["video.framesStalled"] = ("Video frames stopped", "ภาพหยุดส่ง"),
        ["video.gatewayTimeout"] = ("Gateway request timed out", "คำขอ Gateway หมดเวลา"),
        ["video.gatewayUnreachable"] = ("Gateway unreachable", "ติดต่อ Gateway ไม่ได้"),
        ["video.urlFailed"] = ("Cannot get stream URL", "ขอ URL สตรีมไม่สำเร็จ"),
        ["video.retrying"] = ("{0} - retry {1}/{2}", "{0} - ลองใหม่ {1}/{2}"),

        // Shell
        ["app.title"] = ("Surveillance Gateway Client", "Surveillance Gateway Client"),
        ["shell.update"] = ("Update", "อัปเดต"),
        ["shell.updateTo"] = ("Update to {0} and restart", "อัปเดตเป็น {0} แล้วเปิดใหม่"),
        ["shell.updateFailed"] = ("Update could not be installed: {0}", "ติดตั้งอัปเดตไม่สำเร็จ: {0}"),
        ["app.unexpectedError"] = ("Unexpected error (logged, the app keeps running): {0}", "เกิดข้อผิดพลาดไม่คาดคิด (บันทึกไว้แล้ว โปรแกรมยังทำงานต่อ): {0}"),
        ["shell.fullScreen"] = ("Full screen (F11)", "เต็มจอ (F11)"),
        ["shell.exitFullScreen"] = ("Exit full screen (Esc)", "ออกจากเต็มจอ (Esc)"),
        ["shell.minimize"] = ("Minimize", "ย่อหน้าต่าง"),
        ["shell.maximize"] = ("Maximize or restore", "ขยายหรือคืนขนาดหน้าต่าง"),
        ["shell.closeWindow"] = ("Close window", "ปิดหน้าต่าง"),
        ["shell.exitTitle"] = ("Exit Surveillance Gateway Client?", "ออกจาก Surveillance Gateway Client?"),
        ["shell.exitConfirm"] = (
            "All live views and player windows will close.",
            "ภาพสดและหน้าต่างเล่นภาพทั้งหมดจะถูกปิด"),
        ["shell.exit"] = ("Exit", "ออกจากโปรแกรม"),
        ["shell.settings"] = ("Settings", "ตั้งค่า"),
        ["shell.signOut"] = ("Sign out", "ออกจากระบบ"),
        ["shell.navWall"] = ("Video wall", "ผังกล้อง"),
        ["shell.navMap"] = ("Map", "แผนที่"),
        ["shell.navDetail"] = ("Camera details", "รายละเอียดกล้อง"),
        ["shell.notConnected"] = ("Not connected", "ยังไม่ได้เชื่อมต่อ"),
        ["shell.connected"] = ("Connected - {0} · core {1}", "เชื่อมต่อแล้ว - {0} · core {1}"),
        ["shell.eventsUp"] = ("Connected - {0} · live camera status", "เชื่อมต่อแล้ว - {0} · รับสถานะกล้องแบบเรียลไทม์"),
        ["shell.eventsDown"] = ("Connected - {0} · status feed dropped, reconnecting", "เชื่อมต่อแล้ว - {0} · สถานะกล้องหลุด กำลังต่อใหม่"),
        ["shell.key"] = ("key: {0}", "คีย์: {0}"),

        ["shell.navHome"] = ("Home", "หน้าแรก"),
        ["shell.secOverview"] = ("OVERVIEW", "ภาพรวม"),
        ["shell.secMonitoring"] = ("MONITORING", "เฝ้าดู"),
        ["shell.secDevices"] = ("DEVICES", "อุปกรณ์"),
        ["shell.toggleMenu"] = ("Show or hide the menu", "ซ่อน/แสดงเมนู"),

        // Landing page
        ["home.greeting"] = ("Welcome back, {0}", "ยินดีต้อนรับกลับ {0}"),
        ["home.workspace"] = ("OPERATIONS OVERVIEW", "ภาพรวมการปฏิบัติงาน"),
        ["home.quickAccess"] = ("WORKSPACES", "พื้นที่ทำงาน"),
        ["home.liveWorkspace"] = ("LIVE MONITORING", "เฝ้าดูภาพสด"),
        ["home.activity"] = ("ACTIVITY", "ความเคลื่อนไหว"),
        ["home.sub"] = (
            "Monitoring {0} cameras in scope. Choose a workspace to begin.",
            "กำลังดูแลกล้องในสิทธิ์ {0} ตัว เลือกพื้นที่ทำงานเพื่อเริ่มใช้งาน"),
        ["home.online"] = ("Online", "ออนไลน์"),
        ["home.offline"] = ("Offline", "ออฟไลน์"),
        ["home.overview"] = ("OVERVIEW", "ภาพรวม"),
        ["home.cameraHealth"] = ("Camera status", "สถานะกล้อง"),
        ["home.total"] = ("Total", "ทั้งหมด"),
        ["home.other"] = ("Other", "สถานะอื่น"),
        ["home.wallBlurb"] = (
            "Live cells decoded on this machine, in the camera's own codec.",
            "ภาพสดถอดรหัสที่เครื่องนี้ ด้วยโคเดกของกล้องเอง"),
        ["home.wallState"] = ("{0} of {1} cells filled", "ใส่กล้องแล้ว {0} จาก {1} ช่อง"),
        ["home.wallStateView"] = ("View \"{0}\" · {1} of {2} cells filled", "วิว \"{0}\" · ใส่กล้องแล้ว {1} จาก {2} ช่อง"),
        ["home.mapBlurb"] = ("Pins on 3D buildings, from tiles the gateway serves.", "หมุดบนอาคาร 3 มิติ จากไทล์ที่ Gateway เสิร์ฟ"),
        ["home.mapState"] = ("{0} pinned · {1} without coordinates", "ปักหมุดแล้ว {0} · ยังไม่มีพิกัด {1}"),
        ["home.devicesBlurb"] = ("Every camera in scope: streams, tracks, on-camera AI.", "กล้องทุกตัวในขอบเขต: สตรีม แทร็ก และ AI ในหัวกล้อง"),
        ["home.devicesState"] = ("{0} cameras", "{0} ตัว"),
        ["home.events"] = ("Recent events", "เหตุการณ์ล่าสุด"),
        ["home.eventsSub"] = ("From the gateway's live feed", "จากฟีดสดของ Gateway"),
        ["home.eventsSince"] = ("Since this client connected", "ตั้งแต่โปรแกรมนี้เชื่อมต่อ"),
        ["home.noEvents"] = ("Nothing yet - the feed reports changes, and a healthy fleet makes none.", "ยังไม่มี — ฟีดรายงานเฉพาะตอนเปลี่ยนสถานะ ระบบที่ปกติจึงเงียบ"),
        ["home.evtOnline"] = ("{0} stream came back", "สตรีม {0} กลับมาแล้ว"),
        ["home.evtOffline"] = ("{0} stream went offline", "สตรีม {0} หลุด"),
        ["home.buildMismatch"] = (
            "{0} runs build {1} but this gateway runs {2} - update them to the same version, or cameras from it may behave oddly.",
            "{0} รัน build {1} แต่ Gateway นี้รัน {2} — อัปเดตให้ตรงกัน ไม่งั้นกล้องจากเครื่องนั้นอาจทำงานผิดปกติ"),

        // Settings dialog
        ["settings.title"] = ("Settings", "ตั้งค่า"),
        ["settings.preferences"] = ("PREFERENCES", "การแสดงผล"),
        ["settings.subtitle"] = ("This workstation's display and connection", "การแสดงผลและการเชื่อมต่อของเครื่องนี้"),
        ["settings.connection"] = ("CONNECTION & UPDATES", "การเชื่อมต่อและอัปเดต"),
        ["settings.language"] = ("Language", "ภาษา"),
        ["settings.theme"] = ("Theme", "ธีม"),
        ["settings.themeDark"] = ("Dark", "มืด"),
        ["settings.themeLight"] = ("Light", "สว่าง"),
        ["settings.gateway"] = ("Gateway", "Gateway"),
        ["settings.close"] = ("Close", "ปิด"),
        ["settings.note"] = (
            "These settings are stored on this machine only.",
            "ค่าเหล่านี้เก็บไว้ในเครื่องนี้เท่านั้น"),

        ["settings.version"] = ("This client", "โปรแกรมนี้"),
        ["settings.checkUpdate"] = ("Check for updates", "ตรวจหาอัปเดต"),
        ["settings.checking"] = ("Asking the gateway…", "กำลังถาม Gateway…"),
        ["settings.upToDate"] = ("Already the newest version the gateway has.", "เป็นเวอร์ชันใหม่สุดที่ Gateway มีแล้ว"),
        ["settings.updateReady"] = ("Version {0} is downloaded. Restart to use it.", "ดาวน์โหลดเวอร์ชัน {0} แล้ว เปิดใหม่เพื่อใช้งาน"),
        ["settings.restartNow"] = ("Restart now", "เปิดใหม่เลย"),
        ["settings.notInstalled"] = (
            "This build was not installed by the installer, so it cannot update itself.",
            "รุ่นนี้ไม่ได้ติดตั้งผ่านตัวติดตั้ง จึงอัปเดตตัวเองไม่ได้"),

        // Connect
        ["connect.workspace"] = ("SURVEILLANCE", "SURVEILLANCE"),
        ["connect.welcome"] = ("Your cameras, one clear workspace.", "กล้องของคุณ ในพื้นที่ทำงานเดียว"),
        ["connect.welcomeSub"] = ("Connect to a Regional or Central gateway to see live status, video walls and the camera map.", "เชื่อมต่อ Regional หรือ Central เพื่อดูสถานะสด ผังภาพ และแผนที่กล้อง"),
        ["connect.secure"] = ("SECURE OPERATOR ACCESS", "สิทธิ์ผู้ปฏิบัติงาน"),
        ["connect.title"] = ("Connect to Gateway", "เชื่อมต่อ Gateway"),
        ["connect.subtitle"] = ("Connect to the API Gateway with an API key", "เชื่อมต่อไปยัง API Gateway ด้วย API key"),
        ["connect.savedKeys"] = ("Saved keys", "คีย์ที่จำไว้"),
        ["connect.serverUrl"] = ("Server address", "ที่อยู่เซิร์ฟเวอร์"),
        ["connect.apiKey"] = ("API key (sgw_…)", "API key (sgw_…)"),
        ["connect.lostKey"] = (
            "Lost a key? Reveal it again on the API Clients page on the web, from the eye button in the table.",
            "ทำคีย์หาย ขอดูซ้ำได้ที่หน้า API Clients บนเว็บ ปุ่มรูปตาในตาราง"),
        ["connect.connect"] = ("Connect", "เชื่อมต่อ"),
        ["connect.forget"] = ("Forget this key", "ลืมคีย์นี้"),


        // Connect, in code
        ["connect.keyHint"] = ("key: {0}", "คีย์: {0}"),
        ["connect.noKeyYet"] = ("(no key yet)", "(ยังไม่มีคีย์)"),
        ["connect.forgetConfirm"] = (
            "Forget the key for {0} ({1}) on this machine?\n\nThe key still works on the gateway and can be revealed again on the API Clients page.",
            "ลืมคีย์ของ {0} ({1}) บนเครื่องนี้?\n\nคีย์ยังใช้งานได้อยู่บน Gateway และขอดูซ้ำได้ที่หน้า API Clients"),
        ["connect.forgetTitle"] = ("Forget the key", "ลืมคีย์"),
        ["connect.needServer"] = ("Enter the server address first", "ใส่ที่อยู่เซิร์ฟเวอร์ก่อน"),
        ["connect.needKey"] = ("Enter an API key first - issue one on the API Clients page on the web", "ใส่ API key ก่อน — ออกได้จากหน้า API Clients บนเว็บ"),
        ["connect.keyOf"] = ("key of: {0} · core {1}", "คีย์ของ: {0} · core {1}"),
        ["connect.unreachable"] = ("Could not reach {0}: {1}", "ติดต่อ {0} ไม่ได้: {1}"),

        // Wall
        ["wall.library"] = ("CAMERA LIBRARY", "รายการกล้อง"),
        ["wall.toggleFilters"] = ("Show/hide camera filters", "แสดง/ซ่อนตัวกรองกล้อง"),
        ["wall.controls"] = ("WALL CONTROLS", "ตั้งค่าผัง"),
        ["wall.countOnline"] = ("{0} online", "ออนไลน์ {0}"),
        ["wall.countOffline"] = ("{0} offline", "ออฟไลน์ {0}"),
        ["wall.countOther"] = ("{0} other", "สถานะอื่น {0}"),
        ["wall.scopeSimple"] = ("{0} cameras in scope", "กล้องในสิทธิ์ {0} ตัว"),
        ["wall.focus"] = ("CAMERA FOCUS", "ขยายภาพกล้อง"),
        ["wall.backToWall"] = ("← Back to wall", "← กลับไปผังกล้อง"),
        ["wall.filterAll"] = ("All statuses", "ทุกสถานะ"),
        ["wall.favorites"] = ("Favorites only", "เฉพาะรายการโปรด"),
        ["wall.favoriteAdd"] = ("Add to favorites", "เพิ่มในรายการโปรด"),
        ["wall.favoriteRemove"] = ("Remove from favorites", "ลบจากรายการโปรด"),
        ["wall.cycleStart"] = ("Auto cycle", "วนหน้าอัตโนมัติ"),
        ["wall.cycleStop"] = ("Pause cycle", "หยุดวนหน้า"),
        ["status.online"] = ("Online", "ออนไลน์"),
        ["status.offline"] = ("Offline", "ออฟไลน์"),
        ["status.edgeUnavailable"] = ("Edge unreachable", "ติดต่อ Edge ไม่ได้"),
        ["status.missing"] = ("Missing at Edge", "ไม่พบกล้องที่ Edge"),
        ["status.awaitingStream"] = ("Awaiting RTSP", "รอ RTSP"),
        ["status.disabled"] = ("Disabled", "ปิดใช้งาน"),
        ["status.unknown"] = ("Unknown", "ยังไม่ทราบสถานะ"),
        ["wall.reload"] = ("Reload", "โหลดใหม่"),
        ["wall.layout"] = ("Layout", "ผัง"),
        ["dialog.ok"] = ("OK", "ตกลง"),
        ["dialog.cancel"] = ("Cancel", "ยกเลิก"),

        ["wall.clearAll"] = ("Clear all cells", "ล้างทุกช่อง"),
        ["wall.clearAllConfirm"] = ("Clear the camera out of every cell?", "ล้างกล้องออกจากทุกช่อง?"),
        ["wall.view"] = ("View", "วิว"),
        ["wall.viewName"] = ("Name of the view to save", "ชื่อวิวที่จะบันทึก"),
        ["wall.saveView"] = ("Save as view", "บันทึกเป็นวิว"),
        ["wall.deleteView"] = ("Delete view", "ลบวิว"),
        ["wall.deleteViewConfirm"] = ("Delete the view \"{0}\"?", "ลบวิว \"{0}\"?"),
        ["wall.viewSaved"] = ("Saved the view \"{0}\"", "บันทึกวิว \"{0}\" แล้ว"),
        ["wall.viewDeleted"] = ("View deleted", "ลบวิวแล้ว"),
        ["wall.viewOpened"] = ("Opened the view \"{0}\"", "เปิดวิว \"{0}\""),
        ["wall.viewNeedsName"] = ("Name the view before saving it", "ตั้งชื่อวิวก่อนบันทึก"),
        ["wall.hint"] = ("Select a cell, then choose a camera · Double-click to focus · Esc to return", "เลือกช่องแล้วเลือกกล้อง · ดับเบิลคลิกเพื่อขยายภาพ · Esc เพื่อกลับผัง"),
        ["wall.loadFailed"] = ("Could not load the camera list: {0}", "โหลดรายชื่อกล้องไม่ได้: {0}"),

        ["wall.playGroup"] = ("Put this group on the wall", "เอากลุ่มนี้ขึ้นผัง"),
        ["wall.groupPlayed"] = ("{0} · {1} cameras on the wall", "{0} · {1} กล้องบนผัง"),
        ["wall.search"] = ("Search cameras", "ค้นหากล้อง"),
        ["wall.noViews"] = ("No saved views", "ยังไม่มีวิวที่บันทึกไว้"),
        ["wall.noGroup"] = ("(no group)", "(ไม่มีกลุ่ม)"),
        ["wall.hintUnknown"] = ("not played yet", "ยังไม่ได้เล่น"),
        ["wall.stream"] = ("Stream", "สตรีม"),
        ["wall.streamMain"] = ("MAIN", "MAIN"),
        ["wall.streamSub"] = ("SUB", "SUB"),
        ["wall.streamSwitched"] = (
            "The whole wall is on {0}",
            "ทั้งผังเปลี่ยนเป็น {0} แล้ว"),
        ["wall.noSubFallback"] = (
            "{0} of these cameras have no substream and are playing main",
            "{0} ตัวไม่มี substream จึงเล่น main แทน"),
        ["wall.page"] = ("Page {0}/{1}", "หน้า {0}/{1}"),
        ["wall.prevPage"] = ("Previous page", "หน้าก่อน"),
        ["wall.nextPage"] = ("Next page", "หน้าถัดไป"),
        ["wall.groupPaged"] = (
            "{0} · {1} cameras across {2} pages",
            "{0} · {1} กล้อง {2} หน้า"),
        ["wall.dropped"] = ("{0} placed in this cell", "วาง {0} ลงช่องนี้แล้ว"),
        ["wall.swapped"] = ("Cells swapped", "สลับช่องแล้ว"),
        ["wall.chipFellBack"] = ("{0} · no sub", "{0} · ไม่มี sub"),
        ["wall.allGroups"] = ("All groups", "ทุกกลุ่ม"),

        // Cell menu
        ["cell.open"] = ("Expand or restore in wall", "ขยายหรือคืนภาพใน Wall"),
        ["cell.assign"] = ("Put the selected camera here", "ใส่กล้องที่เลือกลงช่องนี้"),
        ["cell.streamSub"] = ("Sub stream", "สตรีมรอง (sub)"),
        ["cell.streamMain"] = ("Main stream", "สตรีมหลัก (main)"),
        ["cell.streamToggle"] = ("Switch this cell between sub and main", "สลับช่องนี้ระหว่างสตรีมรองกับหลัก"),
        ["cell.clear"] = ("Clear this cell", "ล้างช่องนี้"),
        ["cell.unmute"] = ("Turn on sound for this cell", "เปิดเสียงช่องนี้"),
        ["cell.mute"] = ("Mute this cell", "ปิดเสียงช่องนี้"),
        ["cell.empty"] = ("empty", "ว่าง"),

        ["codec.direct"] = ("direct", "ไม่ transcode"),
        ["codec.transcoded"] = ("transcoded", "transcode"),

        // Player window
        ["player.sub"] = ("Sub (sub)", "รอง (sub)"),
        ["player.main"] = ("Main (main)", "หลัก (main)"),
        ["player.minimise"] = ("Minimise", "ย่อ"),
        ["player.maximise"] = ("Maximise", "ขยายเต็ม"),
        ["player.restore"] = ("Restore", "คืนขนาด"),
        ["player.close"] = ("Close", "ปิด"),
        ["ptz.toggle"] = ("Pan, tilt and zoom", "หมุน/ซูมกล้อง (PTZ)"),
        ["ptz.title"] = ("PTZ", "PTZ"),
        ["ptz.hold"] = ("Hold a button to move", "กดค้างเพื่อหมุน ปล่อยเพื่อหยุด"),
        ["ptz.speed"] = ("Speed", "ความเร็ว"),
        ["ptz.zoom"] = ("Zoom", "ซูม"),
        ["ptz.zoomIn"] = ("Zoom in", "ซูมเข้า"),
        ["ptz.zoomOut"] = ("Zoom out", "ซูมออก"),
        ["ptz.home"] = ("Home position", "กลับตำแหน่งเริ่มต้น"),
        ["ptz.up"] = ("Up", "ขึ้น"),
        ["ptz.down"] = ("Down", "ลง"),
        ["ptz.upLeft"] = ("Up and left", "ขึ้นซ้าย"),
        ["ptz.upRight"] = ("Up and right", "ขึ้นขวา"),
        ["ptz.downLeft"] = ("Down and left", "ลงซ้าย"),
        ["ptz.downRight"] = ("Down and right", "ลงขวา"),
        ["ptz.left"] = ("Left", "ซ้าย"),
        ["ptz.right"] = ("Right", "ขวา"),
        ["ptz.presets"] = ("Presets", "Preset"),
        ["ptz.go"] = ("Go", "ไป"),
        ["ptz.remove"] = ("Remove", "ลบ"),
        ["ptz.removeConfirm"] = ("Remove preset \"{0}\" from the camera? Everyone using this camera loses it.", "ลบ preset \"{0}\" ออกจากกล้อง? ทุกคนที่ใช้กล้องนี้จะไม่เห็น preset นี้อีก"),
        ["ptz.newName"] = ("New preset name", "ชื่อ preset ใหม่"),
        ["ptz.save"] = ("Save here", "บันทึกตำแหน่งนี้"),
        ["ptz.saved"] = ("Saved", "บันทึกแล้ว"),
        ["ptz.noPresets"] = ("This camera has no presets", "กล้องนี้ไม่มี preset"),

        // Map
        ["map.reload"] = ("Reload cameras", "โหลดกล้องใหม่"),
        ["map.workspace"] = ("GEOGRAPHIC VIEW", "มุมมองแผนที่"),
        ["map.needsWebView"] = ("Cannot open the map - install the WebView2 Runtime first ({0})", "เปิดแผนที่ไม่ได้ — ติดตั้ง WebView2 Runtime ก่อน ({0})"),
        ["map.loadFailed"] = ("The map page failed to load ({0})", "โหลดหน้าแผนที่ไม่สำเร็จ ({0})"),
        ["map.cameraCount"] = ("{0} cameras · key {1}", "{0} กล้อง · คีย์ {1}"),
        ["map.placed"] = ("{0} cameras on the map", "{0} กล้องบนแผนที่"),
        ["map.placedWithSkipped"] = ("{0} cameras on the map · {1} without coordinates", "{0} กล้องบนแผนที่ · {1} ตัวยังไม่มีพิกัด"),
        ["map.listFailed"] = ("Could not load the camera list: {0}", "โหลดรายชื่อกล้องไม่ได้: {0}"),

        // Camera details
        ["detail.pick"] = ("Pick a camera", "เลือกกล้อง"),
        ["detail.library"] = ("CAMERA LIBRARY", "รายการกล้อง"),
        ["detail.record"] = ("CAMERA RECORD", "ข้อมูลกล้อง"),
        ["detail.none"] = ("No camera selected", "ยังไม่ได้เลือกกล้อง"),
        ["detail.info"] = ("Camera", "ข้อมูลกล้อง"),
        ["detail.streams"] = ("Streams the gateway offers", "สตรีมที่ Gateway ให้มา"),
        ["detail.analytics"] = ("AI in the camera", "AI ในหัวกล้อง"),
        ["detail.open"] = ("Open live view", "เปิดภาพสด"),
        ["detail.showOnMap"] = ("Show on the map", "ดูบนแผนที่"),
        ["detail.back"] = ("Back to the wall", "กลับไปที่ผังกล้อง"),
        ["detail.asking"] = ("Asking the gateway…", "กำลังถาม Gateway…"),
        ["detail.askFailed"] = ("Request failed: {0}", "ถามไม่สำเร็จ: {0}"),
        ["detail.id"] = ("id", "id"),
        ["detail.group"] = ("group", "กลุ่ม"),
        ["detail.brand"] = ("brand", "ยี่ห้อ"),
        ["detail.type"] = ("type", "ชนิด"),
        ["detail.alwaysOn"] = ("always on", "always on"),
        ["detail.location"] = ("location", "พิกัด"),
        ["detail.noLocation"] = ("not pinned yet", "ยังไม่ได้ปักหมุด"),
        ["detail.yes"] = ("yes", "ใช่"),
        ["detail.no"] = ("no", "ไม่"),
        ["detail.aiNone"] = ("none, or switched off", "ไม่มี หรือปิดอยู่"),
        ["detail.aiKind"] = ("kind", "ชนิด"),
        ["detail.aiProbedAt"] = ("probed at", "ตรวจเมื่อ"),
        ["detail.aiRules"] = ("rules", "กฎ"),
        ["detail.core"] = ("core", "core"),
        ["detail.recommended"] = ("recommended for AI", "แนะนำให้ AI ใช้"),
        ["detail.streamMain"] = ("main", "หลัก (main)"),
        ["detail.streamSub"] = ("sub", "รอง (sub)"),
        ["detail.streamMissing"] = ("not offered", "ไม่มี"),
        ["detail.ready"] = ("ready", "พร้อม"),
        ["detail.notReady"] = ("not ready", "ไม่พร้อม"),
        ["detail.readyUnknown"] = ("core did not answer", "ถามคอร์ไม่ได้"),
        ["detail.tracks"] = ("tracks", "tracks"),
        ["detail.passthrough"] = ("no transcode", "ไม่ transcode"),
        ["detail.available"] = ("available", "มี"),
        ["detail.unavailable"] = ("not offered", "ไม่มีให้"),

        // Errors surfaced from the gateway client
        ["error.badKey"] = ("The key is wrong or has been disabled", "คีย์ไม่ถูกต้องหรือถูกปิดใช้งาน"),
        ["error.notGateway"] = ("This address is not an API Gateway", "ปลายทางนี้ไม่ใช่ API Gateway"),
        ["error.keyRejected"] = ("The key was rejected - check that it is still enabled", "คีย์ถูกปฏิเสธ - ตรวจสอบว่ายังใช้งานได้อยู่"),
        ["error.outOfScope"] = ("This camera is not in the key's scope", "กล้องนี้ไม่อยู่ในขอบเขตของคีย์"),

        // AI events (docs/EDGE-PLAN.md phase 5) and edge alerts
        ["shell.navEvents"] = ("AI events", "เหตุการณ์ AI"),
        ["shell.navPlayback"] = ("Playback", "ภาพย้อนหลัง"),
        ["playback.search"] = ("Search cameras", "ค้นหากล้อง"),
        ["playback.selectCamera"] = ("Select a camera", "เลือกกล้อง"),
        ["playback.cameras"] = ("CAMERAS", "กล้อง"),
        ["playback.hint"] = (
            "Pick a camera, then click the timeline or press play",
            "เลือกกล้อง แล้วคลิกบนเส้นเวลาหรือกดเล่น"),
        ["playback.prevDay"] = ("Previous day", "วันก่อนหน้า"),
        ["playback.nextDay"] = ("Next day", "วันถัดไป"),
        ["playback.today"] = ("Today", "วันนี้"),
        ["playback.playPause"] = ("Play / pause", "เล่น / พัก"),
        ["playback.back30"] = ("Back 30 seconds", "ย้อน 30 วินาที"),
        ["playback.forward30"] = ("Forward 30 seconds", "ข้ามไป 30 วินาที"),
        ["playback.prevRecording"] = ("Previous recording", "ช่วงบันทึกก่อนหน้า"),
        ["playback.nextRecording"] = ("Next recording", "ช่วงบันทึกถัดไป"),
        ["playback.goTo"] = ("Go", "ไป"),
        ["playback.goToHint"] = ("Jump to a time (HH:mm:ss), then Enter", "ไปที่เวลา (HH:mm:ss) แล้วกด Enter"),
        ["playback.zoomIn"] = ("Zoom in (or mouse wheel on the timeline)", "ซูมเข้า (หรือหมุนล้อเมาส์บนเส้นเวลา)"),
        ["playback.zoomOut"] = ("Zoom out", "ซูมออก"),
        ["playback.zoomFit"] = ("Whole day", "ดูทั้งวัน"),
        ["playback.legendRecorded"] = ("Recorded", "มีภาพบันทึก"),
        ["playback.summary"] = ("{0} ranges · {1} h recorded", "{0} ช่วง · บันทึกรวม {1} ชม."),
        ["playback.idle"] = ("Select a camera", "เลือกกล้องเพื่อเริ่ม"),
        ["playback.ready"] = ("Ready - click the timeline or press play", "พร้อม - คลิกเส้นเวลาหรือกดเล่น"),
        ["playback.nowPlaying"] = ("Playing", "กำลังเล่น"),
        ["playback.paused"] = ("Paused", "พักอยู่"),
        ["playback.ended"] = ("End of recording", "สิ้นสุดภาพบันทึก"),
        ["playback.endOfDay"] = ("End of day - pick the next date to keep watching", "สิ้นสุดวัน - เลือกวันถัดไปเพื่อดูต่อ"),
        ["playback.noVideoHere"] = ("No recording after this time", "ไม่มีภาพบันทึกหลังเวลานี้"),
        ["playback.stop"] = ("Stop", "หยุด"),
        ["playback.stopped"] = ("Stopped", "หยุดแล้ว"),
        ["playback.refresh"] = ("Reload recordings", "โหลดช่วงบันทึกใหม่"),
        ["playback.loading"] = ("Loading recordings…", "กำลังโหลดภาพย้อนหลัง…"),
        ["playback.empty"] = ("No recordings on this date", "ไม่พบภาพบันทึกในวันนี้"),
        ["playback.badTime"] = ("Enter time as HH:mm:ss", "กรอกเวลาเป็น HH:mm:ss"),
        ["playback.playing"] = ("Opening playback…", "กำลังเปิดภาพย้อนหลัง…"),
        ["playback.streamError"] = ("Playback stream failed", "สตรีมภาพย้อนหลังล้มเหลว"),
        ["playback.forbidden"] = ("This API key cannot view playback", "API key นี้ไม่มีสิทธิ์ดูภาพย้อนหลัง"),
        ["playback.download"] = ("Download MP4", "ดาวน์โหลด MP4"),
        ["playback.downloadHint"] = ("Select a continuous recording within this date. Maximum 30 minutes per file; one download at a time. Times are Bangkok time.", "เลือกช่วงบันทึกต่อเนื่องในวันที่เปิดอยู่ สูงสุด 30 นาทีต่อไฟล์ และ 1 งานพร้อมกัน เวลาเป็นเวลาประเทศไทย"),
        ["playback.downloadStart"] = ("Start (HH:mm:ss)", "เริ่ม (HH:mm:ss)"),
        ["playback.downloadEnd"] = ("End (HH:mm:ss)", "สิ้นสุด (HH:mm:ss)"),
        ["playback.downloadLimit"] = ("Select 1 second to 30 minutes; end must be after start.", "เลือกช่วง 1 วินาทีถึง 30 นาที โดยเวลาสิ้นสุดต้องหลังเวลาเริ่ม"),
        ["playback.downloadGap"] = ("This interval includes a gap in recordings. Select a continuous recorded interval.", "ช่วงที่เลือกมีเวลาที่ไม่พบภาพบันทึก ให้เลือกช่วงที่มีภาพต่อเนื่อง"),
        ["playback.downloadSelect"] = ("Select a camera and load recordings first.", "เลือกกล้องและโหลดช่วงบันทึกก่อนดาวน์โหลด"),
        ["playback.downloadFilter"] = ("MP4 video (*.mp4)|*.mp4", "วิดีโอ MP4 (*.mp4)|*.mp4"),
        ["playback.downloadPreparing"] = ("Opening recording…", "กำลังเปิดภาพบันทึก…"),
        ["playback.downloadProgress"] = ("Downloaded {0:F1} MB", "ดาวน์โหลดแล้ว {0:F1} MB"),
        ["playback.downloadSaved"] = ("Saved: {0}", "บันทึกแล้ว: {0}"),
        ["playback.downloadCancel"] = ("Cancel download", "ยกเลิกดาวน์โหลด"),
        ["playback.downloadClose"] = ("Close", "ปิด"),
        ["playback.downloadCancelled"] = ("Download cancelled.", "ยกเลิกดาวน์โหลดแล้ว"),
        ["playback.downloadBusy"] = ("A download is already running in this client.", "client นี้กำลังดาวน์โหลดอยู่แล้ว"),
        ["playback.downloadInvalid"] = ("Gateway returned an empty or invalid MP4.", "Gateway ส่ง MP4 ว่างหรือรูปแบบไม่ถูกต้อง"),
        ["playback.downloadTimeout"] = ("Download stalled for 90 seconds. Please try again.", "ดาวน์โหลดไม่มีข้อมูลตอบกลับเกิน 90 วินาที กรุณาลองใหม่"),
        ["playback.downloadHttpError"] = ("Download failed (HTTP {0}).", "ดาวน์โหลดไม่สำเร็จ (HTTP {0})"),
        ["playback.noUrl"] = ("Gateway did not provide a playback URL", "Gateway ไม่ส่ง URL ภาพย้อนหลัง"),
        ["shell.edgeDown"] = ("{0} edge offline", "edge ติดต่อไม่ได้ {0} เครื่อง"),
        ["shell.edgeDownTip"] = ("Cameras behind these edges have no picture and no events:\n{0}", "กล้องของ edge เหล่านี้ไม่มีภาพและไม่มี event:\n{0}"),
        ["events.eyebrow"] = ("ANALYTICS", "การวิเคราะห์"),
        ["events.sub"] = ("Last 24 hours · {0} events · new ones appear as they happen", "24 ชั่วโมงล่าสุด · {0} รายการ · รายการใหม่ขึ้นเองทันที"),
        ["events.loading"] = ("Loading…", "กำลังโหลด…"),
        ["events.loadFailed"] = ("Could not load events: {0}", "โหลดเหตุการณ์ไม่ได้: {0}"),
        ["events.refresh"] = ("Refresh", "รีเฟรช"),
        ["events.empty"] = (
            "No AI events in the last 24 hours for these filters. Enable an AI source at Edge to receive events from cameras, NVRs, VMS or external APIs.",
            "ไม่มีเหตุการณ์ AI ใน 24 ชั่วโมงล่าสุดตามตัวกรอง — เปิดแหล่งรับ AI ที่ Edge เพื่อรับผลจากกล้อง/NVR/VMS/API ภายนอก"),
        ["events.origin.camera"] = ("camera", "กล้อง"),
        ["events.origin.nvr"] = ("NVR", "NVR"),
        ["events.origin.vms"] = ("VMS", "VMS"),
        ["events.origin.api"] = ("external API", "API ภายนอก"),
        ["events.origin.edge-ai"] = ("edge AI (legacy)", "AI ของ Edge (เดิม)"),
        ["events.origin.unknown"] = ("unspecified", "ไม่ระบุ"),
        ["events.filter.edge"] = ("Edge", "Edge"),
        ["events.filter.group"] = ("Group", "กลุ่ม"),
        ["events.filter.origin"] = ("Source", "ที่มา"),
        ["events.filter.allEdges"] = ("All edges", "ทุก Edge"),
        ["events.filter.allGroups"] = ("All groups", "ทุกกลุ่ม"),
        ["events.filter.allOrigins"] = ("All sources", "ทุกแหล่ง"),
        ["events.edgeValue"] = ("Edge {0}", "Edge {0}"),
        ["events.detail.capturedAt"] = ("CAPTURED", "เวลาจับภาพ"),
        ["events.detail.imageSource"] = ("IMAGE", "ภาพ"),
        ["events.image.device"] = ("Device alarm image", "ภาพ Alarm จากอุปกรณ์"),
        ["events.image.triggered"] = ("Snapshot when event received", "ภาพที่ดึงเมื่อรับเหตุ"),
        ["events.fromEdge"] = ("edge AI", "AI ของ edge"),
        ["events.direction"] = ("direction {0}", "ทิศ {0}"),
        ["events.detail.close"] = ("Close", "ปิด"),
        ["events.detail.prev"] = ("Previous event (←)", "เหตุการณ์ก่อนหน้า (←)"),
        ["events.detail.next"] = ("Next event (→)", "เหตุการณ์ถัดไป (→)"),
        ["events.detail.time"] = ("TIME", "เวลา"),
        ["events.detail.seen"] = ("SEEN", "เห็นช่วง"),
        ["events.detail.seenValue"] = ("{0} – {1} ({2} s)", "{0} – {1} ({2} วิ)"),
        ["events.detail.rule"] = ("RULE", "กฎ"),
        ["events.detail.direction"] = ("DIRECTION", "ทิศ"),
        ["events.detail.track"] = ("TRACK", "track"),
        ["events.detail.confidence"] = ("CONFIDENCE", "ความมั่นใจ"),
        ["events.detail.source"] = ("SOURCE", "ที่มา"),
        ["events.detail.noSnapshot"] = ("No snapshot", "ไม่มีภาพประกอบ"),
        ["events.type.line_cross"] = ("Line crossed", "ข้ามเส้น"),
        ["events.type.intrusion"] = ("Zone entered", "บุกรุกโซน"),
        ["events.type.loitering"] = ("Loitering", "อยู่ในโซนนานเกิน"),
        ["events.type.object"] = ("Object seen", "พบวัตถุ"),
        ["events.label.person"] = ("person", "คน"),
        ["events.label.car"] = ("car", "รถยนต์"),
        ["events.label.motorcycle"] = ("motorcycle", "จักรยานยนต์"),
        ["events.label.bicycle"] = ("bicycle", "จักรยาน"),
        ["events.label.bus"] = ("bus", "รถบัส"),
        ["events.label.truck"] = ("truck", "รถบรรทุก"),
    };

    /// <summary>"en" or "th".</summary>
    public string Language => _language;

    /// <summary>
    /// The string for a key.
    ///
    /// A missing key returns the key itself rather than throwing or returning empty: a typo shows
    /// up on screen as `wall.clearr`, which is obvious, instead of as a blank button.
    /// </summary>
    public string this[string key] =>
        Table.TryGetValue(key, out var pair) ? (_language == "th" ? pair.Th : pair.En) : key;

    public void SetLanguage(string language)
    {
        var next = language == "th" ? "th" : "en";
        if (next == _language)
        {
            return;
        }

        _language = next;

        // "Item[]" is what WPF listens for to re-evaluate indexer bindings, which is how every
        // `{loc:T}` in the XAML updates without the views being rebuilt.
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs("Item[]"));
        LanguageChanged?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>Shorthand for code-behind: <c>Strings.T("wall.clearAll")</c>.</summary>
    public static string T(string key) => Current[key];

    /// <summary>
    /// The string for a key built from data (an event type, an object class), or <paramref name="fallback"/>
    /// when the table has no entry - a new type from the gateway shows as itself, not as a key.
    /// </summary>
    public static string TOr(string key, string fallback) => Table.ContainsKey(key) ? Current[key] : fallback;

    /// <summary>Shorthand with formatting: <c>Strings.T("wall.scopeSimple", 9)</c>.</summary>
    public static string T(string key, params object?[] args) => string.Format(Current[key], args);

    /// <summary>Raised after the language changes, for text built in code rather than bound.</summary>
    public event EventHandler? LanguageChanged;

    public event PropertyChangedEventHandler? PropertyChanged;
}

/// <summary>
/// `Text="{loc:T wall.cameras}"` in XAML.
///
/// Returns a binding rather than a string so the text follows a language change while the app is
/// running. A plain string here would need every window rebuilt to switch language.
/// </summary>
public sealed class TExtension : MarkupExtension
{
    public TExtension()
    {
    }

    public TExtension(string key) => Key = key;

    public string Key { get; set; } = string.Empty;

    public override object ProvideValue(IServiceProvider serviceProvider) =>
        new System.Windows.Data.Binding($"[{Key}]")
        {
            Source = Strings.Current,
            Mode = System.Windows.Data.BindingMode.OneWay,
        }.ProvideValue(serviceProvider);
}
