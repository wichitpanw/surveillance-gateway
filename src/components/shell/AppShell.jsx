import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, Menu, X, LogOut, Moon, Sun, Languages, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { can } from '@/lib/roles';
import { flatNav } from '@/lib/app-config';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useLanguage } from '@/lib/i18n';
import HardwareMonitor from '@/components/HardwareMonitor';

/*
  โครงหน้าจอตามแบบ reference edge project : sidebar มืดหุบได้ · navbar มี breadcrumb ·
  แถบ tab ของหน้าที่เปิดค้างไว้ · หน้าเลื่อนเข้าแบบ fade-transform ตอนสลับ

  เนื้อหาในแต่ละหน้ายังเป็นของระบบเราเอง — ยืมแค่วิธีจัดหน้าจอ ไม่ได้ยืมแนวคิด GB28181
*/

function Sidebar({ app, user, currentTab, onOpen, collapsed }) {
  const { t } = useLanguage();
  return (
    <aside
      className={cn(
        'shell-sidebar flex h-full shrink-0 flex-col bg-[#0b0b0c] text-neutral-400 transition-[width] duration-300 ease-out',
        collapsed ? 'w-16' : 'w-[220px]',
      )}
    >
      {/*
        ชื่อโปรแกรม — ชื่อคือสิ่งที่บอกว่ากำลังอยู่ในเครื่อง central หรือ edge
        ไม่มีโลโก้แบรนด์ (ระบบกลาง) — ช่องสี่เหลี่ยมใส่อักษรแรกไว้ให้เห็นชั้นของโปรแกรมตอนพับเมนู
      */}
      <div className="flex h-[50px] items-center gap-2.5 overflow-hidden border-b border-white/5 px-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded bg-primary text-sm font-bold text-primary-foreground">
          {app.short.charAt(0)}
        </div>
        {!collapsed && (
          <div className="flex min-w-0 flex-col leading-tight animate-fade-in">
            <span className="truncate text-[13px] font-semibold text-white">{app.short}</span>
            <span className="truncate text-[10px] uppercase tracking-[0.14em] text-neutral-500">{app.tagline}</span>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 custom-scrollbar">
        {app.nav.map((sec) => {
          const items = sec.items.filter((it) => !it.perm || can(user, it.perm));
          if (!items.length) return null;
          return (
            <div key={sec.key} className="mb-2">
              {collapsed
                ? <div className="mx-4 my-2 border-t border-white/5" />
                : <div className="px-5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-600">{sec.label}</div>}
              {items.map((it) => {
                const Icon = it.icon;
                const active = currentTab === it.tab;
                return (
                  <button
                    key={it.tab}
                    type="button"
                    title={collapsed ? it.label : undefined}
                    onClick={() => onOpen(it.tab)}
                    className={cn(
                      'group relative flex h-11 w-full items-center gap-3 text-left text-[13px] transition-colors',
                      collapsed ? 'justify-center px-0' : 'px-5',
                      active ? 'bg-white/[0.06] text-white' : 'hover:bg-white/[0.04] hover:text-neutral-200',
                    )}
                  >
                    {/* แถบเหลืองแบรนด์ด้านซ้ายของเมนูที่เลือก */}
                    <span className={cn('absolute left-0 top-0 h-full w-[3px] bg-brand transition-transform duration-200 origin-center', active ? 'scale-y-100' : 'scale-y-0')} />
                    <Icon className="size-[18px] shrink-0" />
                    {!collapsed && <span className="truncate">{it.label}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* เครดิตผู้พัฒนา — agents.md ข้อ 5 ห้ามเอาออก · แสดงเมื่อ sidebar กางอยู่ */}
      {!collapsed && (
        <div className="flex shrink-0 flex-col items-center gap-0.5 border-t border-white/5 py-2 animate-fade-in" title="powered by Warapon Wichitpan">
          <span className="font-mono text-[8px] uppercase tracking-[0.3em] text-neutral-600">{t('poweredBy')}</span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-500">Warapon Wichitpan</span>
        </div>
      )}
    </aside>
  );
}

/** เมนูผู้ใช้มุมขวาบน — ปิดเองเมื่อคลิกข้างนอก */
function UserMenu({ user, theme, toggleTheme, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { language, setLanguage, t } = useLanguage();
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
        <span className="flex size-7 items-center justify-center rounded bg-foreground text-[11px] font-semibold text-background">
          {user?.username?.charAt(0).toUpperCase()}
        </span>
        <span className="hidden text-xs font-medium sm:block">{user?.username}</span>
        <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border bg-card shadow-lg animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="border-b px-3 py-2.5">
            <div className="text-sm font-medium">{user?.username}</div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{user?.role}</div>
          </div>
          <button type="button" onClick={toggleTheme} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted">
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button type="button" onClick={() => setLanguage(language === 'th' ? 'en' : 'th')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted">
            <Languages className="size-4" /> {language === 'th' ? 'English' : 'ภาษาไทย'}
          </button>
          <button type="button" onClick={() => { setOpen(false); onLogout(); }} className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm text-destructive hover:bg-muted">
            <LogOut className="size-4" /> {t('signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * แถบ tab ของหน้าที่เปิดค้างไว้ (tags-view ของ reference edge project)
 * Dashboard ปิดไม่ได้ (affix) · ปิด tab ที่กำลังดูอยู่ → กระโดดไป tab ข้าง ๆ
 */
function TagsView({ tabs, currentTab, nav, home, onSelect, onClose }) {
  return (
    <div className="flex h-[38px] shrink-0 items-center gap-1.5 overflow-x-auto border-b bg-card px-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      {tabs.map((tab) => {
        const item = nav.find((n) => n.tab === tab);
        if (!item) return null;
        const active = tab === currentTab;
        return (
          <div
            key={tab}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(tab)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect(tab); }}
            onAuxClick={(e) => { if (e.button === 1 && tab !== home) onClose(tab); }}
            className={cn(
              'group flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-sm border px-2.5 text-xs transition-colors animate-in fade-in zoom-in-95 duration-150',
              active ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {active && <span className="size-1.5 rounded-full bg-brand" />}
            <span className="whitespace-nowrap">{item.label}</span>
            {tab !== home && (
              <button
                type="button"
                aria-label={`Close ${item.label}`}
                onClick={(e) => { e.stopPropagation(); onClose(tab); }}
                className={cn('-mr-1 rounded-full p-0.5 transition-colors', active ? 'hover:bg-background/20' : 'hover:bg-muted')}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function AppShell({
  app, user, currentTab, setCurrentTab, theme, toggleTheme, onLogout, systemStats, children,
}) {
  const nav = flatNav(app);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('shell_collapsed') === '1'; } catch { return false; }
  });
  const [tabs, setTabs] = useState([app.home]);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const { t } = useLanguage();

  // หน้าไหนถูกเปิด (จากเมนูหรือจากปุ่มในหน้าอื่น) ต้องมี tab ของมันเสมอ
  const shownTabs = tabs.includes(currentTab) ? tabs : [...tabs, currentTab];

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try { localStorage.setItem('shell_collapsed', c ? '0' : '1'); } catch { /* storage ปิดอยู่ */ }
      return !c;
    });
  };

  const open = (tab) => {
    setTabs((prev) => (prev.includes(tab) ? prev : [...prev, tab]));
    setCurrentTab(tab);
  };

  const close = (tab) => {
    const idx = shownTabs.indexOf(tab);
    const next = shownTabs.filter((x) => x !== tab);
    setTabs(next);
    if (tab === currentTab) setCurrentTab(next[Math.max(0, idx - 1)] || app.home);
  };

  const current = nav.find((n) => n.tab === currentTab);

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background">
      <Sidebar app={app} user={user} currentTab={currentTab} onOpen={open} collapsed={collapsed} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-[50px] shrink-0 items-center gap-3 border-b bg-card px-3">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={collapsed ? t('showMenu') : t('hideMenu')}
          >
            <Menu className={cn('size-[18px] transition-transform duration-300', collapsed && 'rotate-90')} />
          </button>

          {/* breadcrumb: โปรแกรม / หมวด / หน้า */}
          <nav className="flex min-w-0 items-center gap-1.5 text-[13px]">
            <span className="shrink-0 text-muted-foreground">{app.name}</span>
            {current && (
              <>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                <span className="hidden shrink-0 text-muted-foreground sm:inline">{current.section}</span>
                <ChevronRight className="hidden size-3.5 shrink-0 text-muted-foreground/60 sm:inline" />
                <span key={currentTab} className="truncate font-medium animate-in fade-in slide-in-from-left-1 duration-200">{current.label}</span>
              </>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden lg:block"><HardwareMonitor systemStats={systemStats} /></div>
            <UserMenu user={user} theme={theme} toggleTheme={toggleTheme} onLogout={() => setLogoutOpen(true)} />
          </div>
        </header>

        <TagsView tabs={shownTabs} currentTab={currentTab} nav={nav} home={app.home} onSelect={setCurrentTab} onClose={close} />

        <main className="flex-1 overflow-y-auto bg-muted/30 p-5 lg:p-6 custom-scrollbar">
          {/* key บังคับให้ React สร้างใหม่ทุกครั้งที่สลับหน้า animation fade-transform จึงเล่นทุกครั้ง */}
          <div key={currentTab} className="page-transition mx-auto max-w-[1600px] pb-16">
            {children}
          </div>
        </main>
      </div>

      <ConfirmationDialog
        isOpen={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        onConfirm={onLogout}
        title={t('confirmLogoutTitle')}
        description={t('confirmLogoutDesc')}
        confirmText={t('terminateSession')}
        cancelText={t('abort')}
        variant="destructive"
      />
    </div>
  );
}
