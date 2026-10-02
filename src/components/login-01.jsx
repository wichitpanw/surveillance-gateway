import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";


export default function Login01({ loginForm, setLoginForm, handleLogin, isLoading, loginError, theme, toggleTheme, appName = "Surveillance Gateway Central", showClient = true }) {
  /*
    เวอร์ชันของตัวติดตั้งที่ gateway นี้กำลังปล่อยอยู่

    อ่านจากไฟล์ index ของ Velopack เอง ไม่ฝังเลขไว้ในหน้าเว็บ — เลขที่ฝังไว้จะค้างเป็นของเก่า
    ทันทีที่มีคนปล่อยเวอร์ชันใหม่ด้วย build-client-release.ps1 โดยไม่ได้แก้ไฟล์นี้

    อ่านไม่ได้ (ยังไม่เคย build release โฟลเดอร์จึงไม่มี และ express.static ตอบ 404) = ซ่อนทั้ง
    บล็อกไปเลย ดีกว่าโชว์ปุ่มที่กดแล้วได้ 404
  */
  const [clientVersion, setClientVersion] = useState(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/client-updates/releases.win.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const versions = (data.Assets || [])
          .filter((a) => a.Type === 'Full' && a.Version)
          .map((a) => a.Version);
        if (versions.length === 0) return;

        // เรียงแบบตัวเลขทีละส่วน ไม่ใช่เรียงสตริง — ไม่งั้น 1.2.9 จะมาทีหลัง 1.2.11
        versions.sort((a, b) => {
          const pa = a.split('.').map(Number);
          const pb = b.split('.').map(Number);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
          }
          return 0;
        });
        setClientVersion(versions[versions.length - 1]);
      })
      .catch(() => { /* gateway นี้ไม่ได้ปล่อยตัวติดตั้ง — ไม่ใช่ข้อผิดพลาด */ });

    return () => { cancelled = true; };
  }, []);

  // รักษาโครงสร้าง/ลำดับฟิลด์ของ blocks/login-01 อย่างเคร่งครัด อ้างอิงตามคู่มือของ Warapon Wichitpan —
  // การปรับปรุงด้านล่าง (glow พื้นหลัง, เงาโลโก้, hover ปุ่ม) เป็นการตกแต่งเพิ่มเติมเท่านั้น ไม่แตะโครง/ลำดับฟอร์ม
  return (
    <div className="relative flex items-center justify-center min-h-dvh bg-background transition-colors duration-500 overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(600px 500px at 50% 8%, hsl(var(--primary) / 0.10), transparent 60%), radial-gradient(420px 360px at 85% 90%, hsl(var(--primary) / 0.06), transparent 65%)',
        }}
      />
      <div className="absolute top-8 right-8">
        <Button 
          variant="ghost" 
          size="icon" 
          onClick={toggleTheme}
          className="rounded-full"
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </Button>
      </div>

      <div className="relative flex flex-1 flex-col justify-center px-4 py-10 lg:px-6 animate-fade-in">
        <div className="sm:mx-auto sm:w-full sm:max-w-sm">
          <div className="flex flex-col items-center mb-6">
            {/*
              ไม่มีพื้นไล่สีรองโลโก้แล้ว — โลโก้ องค์กร มีสีของตัวเองครบและพื้นหลังโปร่ง
              การวางบนพื้นสี primary ทำให้สีเหลืองของโลโก้ชนกับพื้นจนแยกไม่ออก
            */}
            <img
              src="/gw-logo.png"
              alt="Surveillance Gateway"
              className="mb-4 h-12 w-auto rounded dark:bg-foreground dark:px-3 dark:py-2"
            />
            <h2 className="text-balance text-center text-xl font-semibold text-foreground">
              {appName}
            </h2>
          </div>

          <form onSubmit={handleLogin} className="mt-6 flex flex-col gap-4">
            <div>
              <Label htmlFor="username" className="font-medium text-foreground">
                Username / Email
              </Label>
              <Input
                type="text"
                id="username"
                value={loginForm.username}
                onChange={e => setLoginForm({...loginForm, username: e.target.value})}
                placeholder="john@company.com"
                required
                className="mt-2"
              />
            </div>

            <div>
              <Label htmlFor="password" className="font-medium text-foreground">
                Password
              </Label>
              <Input
                type="password"
                id="password"
                value={loginForm.password}
                onChange={e => setLoginForm({...loginForm, password: e.target.value})}
                placeholder="••••••••"
                required
                className="mt-2"
              />
            </div>

            {loginError && (
              <p className="text-destructive text-xs font-medium text-center animate-pulse mt-1">
                {loginError}
              </p>
            )}

            <Button
              type="submit"
              disabled={isLoading}
              className="mt-2 w-full shadow-[0_1px_1px_rgba(0,0,0,0.08),0_8px_18px_-6px_hsl(var(--primary)/0.45)] transition-transform hover:-translate-y-0.5"
            >
              {isLoading ? "Signing in..." : "Sign in"}
            </Button>
          </form>



          {/*
              ตัวติดตั้งของ Windows client อยู่ตรงนี้เพราะคนที่เพิ่งได้เครื่องมาต้องโหลดก่อนจะมีบัญชี
              ไฟล์ใน /client-updates เสิร์ฟโดยไม่ต้องล็อกอินอยู่แล้วโดยเจตนา (server.js:3756)
          */}
          {/* client ต่อ central เท่านั้น — หน้า login ของ edge จึงไม่มีตัวติดตั้ง */}
          {showClient && clientVersion && (
            <div className="mt-8 rounded-lg border bg-muted/20 p-4 text-center">
              <p className="text-xs font-semibold text-foreground">Surveillance Gateway Client</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                โปรแกรมดูกล้องสำหรับ Windows · เวอร์ชัน {clientVersion}
              </p>
              <Button asChild variant="outline" className="mt-3 w-full">
                <a href="/client-updates/SurveillanceGateway-win-Setup.exe" download>
                  ดาวน์โหลดตัวติดตั้ง
                </a>
              </Button>
            </div>
          )}

          <p className="text-pretty mt-6 text-xs text-muted-foreground text-center">
            By signing in, you agree to our{" "}
            <a href="#" className="underline underline-offset-4">
              terms of service
            </a>{" "}
            and{" "}
            <a href="#" className="underline underline-offset-4">
              privacy policy
            </a>.
          </p>
          
          <p className="mt-8 text-[9px] text-muted-foreground text-center font-medium opacity-40 uppercase tracking-widest">
            powered by Warapon Wichitpan
          </p>
        </div>
      </div>
    </div>
  );
}
