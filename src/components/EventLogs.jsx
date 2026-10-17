import React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from '@/lib/toast';
import { formatThaiDateTime, formatThaiTime, formatThaiDate } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  Calendar, 
  Filter, 
  Trash2, 
  ClipboardList, 
  ImageIcon,
  ShieldCheck,
  UserCheck,
  Activity,
  Search,
  Database,
  Terminal,
  Download
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/i18n";

/**
 * Event Logs Component - Monochrome Shadcn Style
 * ปรับปรุงการแยกประเภทและระบบตัวกรองให้ละเอียดขึ้นตามคำขอของผู้ดูแลค่ะ 👓✨
 */
const EventLogs = ({
  logFilters,
  setLogFilters,
  handleClearLogs,
  logs,
  setSelectedEventImage,
  canPurgeLogs = false,
}) => {
  const { t } = useLanguage();
  // ฟังก์ชันช่วยส่งออกประวัติระบบเป็นไฟล์ CSV ค่ะ
  const handleExportCSV = () => {
    if (logs.length === 0) {
      toast({ title: t('noLogsToExport'), variant: 'destructive' });
      return;
    }
    
    // กำหนดหัวข้อคอลัมน์ของไฟล์ CSV
    const headers = ["Timestamp", "Category", "Principal", "Action", "Metadata Details"];
    const csvRows = [headers.join(",")];
    
    logs.forEach(log => {
      const category = getLogCategory(log.action);
      const timeStr = formatThaiDateTime(log.timestamp);
      const row = [
        `"${timeStr}"`,
        `"${category.label}"`,
        `"${log.username || log.user || 'SYSTEM'}"`,
        `"${log.action || 'EVENT'}"`,
        `"${(log.details || '').replace(/"/g, '""')}"` // ป้องกันเรื่อง Double quotes ในไฟล์ CSV
      ];
      csvRows.push(row.join(","));
    });
    
    // แนบ UTF-8 Byte Order Mark (BOM) เพื่อให้ Excel เปิดภาษาไทยได้อย่างถูกต้อง
    const BOM = "\uFEFF";
    const csvContent = BOM + csvRows.join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `VMS-AuditLogs-${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ฟังก์ชันช่วยจัดหมวดหมู่สีตามประเภทเหตุการณ์ค่ะ
  const getLogCategory = (action) => {
    const act = action?.toLowerCase() || '';
    if (act.includes('login') || act.includes('user')) return { label: 'IDENTITY', icon: <UserCheck className="size-3" />, variant: 'secondary' };
    if (act.includes('alert') || act.includes('offline')) return { label: 'SECURITY', icon: <ShieldCheck className="size-3" />, variant: 'destructive' };
    if (act.includes('add') || act.includes('delete') || act.includes('save')) return { label: 'AUDIT', icon: <Activity className="size-3" />, variant: 'default' };
    return { label: 'SYSTEM', icon: <Terminal className="size-3" />, variant: 'outline' };
  };

  return (
    <div className="flex flex-col gap-6 animate-fade-in font-sans pb-10">
      {/* ส่วนหัว: Intelligence Audit */}
      <div className="flex flex-col lg:flex-row justify-between lg:items-end gap-6 px-2">
        <div>
           <h2 className="text-2xl font-bold tracking-tight">Intelligence Audit</h2>
           <p className="text-muted-foreground text-sm font-medium mt-1">High-fidelity system event logging and forensic activity records.</p>
        </div>
        
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          {/* Quick Stats in Header */}
          <div className="hidden xl:flex items-center gap-4 mr-4 border-r pr-6">
             <div className="flex flex-col">
                <span className="text-[10px] font-black text-muted-foreground uppercase opacity-40">Total Events</span>
                <span className="text-lg font-black font-mono">{logs.length}</span>
             </div>
             <div className="flex flex-col">
                <span className="text-[10px] font-black text-muted-foreground uppercase opacity-40">Security Alerts</span>
                <span className="text-lg font-black font-mono text-destructive">{logs.filter(l => l.action?.toLowerCase().includes('alert')).length}</span>
             </div>
          </div>

          {/* Unified Filter Bar */}
          <Card className="flex flex-wrap items-center gap-2 p-1.5 border shadow-xs bg-card transition-all">
            <div className="flex items-center gap-2 px-3 border-r h-8">
              <Calendar className="size-3.5 text-muted-foreground opacity-50" />
              <input 
                type="date" 
                value={logFilters.date} 
                onChange={(e) => setLogFilters({ ...logFilters, date: e.target.value })}
                className="bg-transparent text-[11px] font-black uppercase outline-hidden [color-scheme:light] dark:[color-scheme:dark]"
              />
            </div>
            
            <div className="flex items-center gap-2 min-w-[160px] h-8 px-2">
              <Filter className="size-3.5 text-muted-foreground opacity-50" />
              <Select 
                value={logFilters.type} 
                onValueChange={(val) => setLogFilters({ ...logFilters, type: val })}
              >
                <SelectTrigger className="h-full border-none bg-transparent p-0 text-[11px] font-black uppercase shadow-none focus:ring-0">
                  <SelectValue placeholder="All Categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-[10px] font-black uppercase">All Event Tiers</SelectItem>
                  <SelectItem value="Camera Alert" className="text-[10px] font-black uppercase">Security Alerts</SelectItem>
                  <SelectItem value="Login" className="text-[10px] font-black uppercase">Authentication</SelectItem>
                  <SelectItem value="Add Camera" className="text-[10px] font-black uppercase">Asset Ingress</SelectItem>
                  <SelectItem value="Delete Camera" className="text-[10px] font-black uppercase">Asset Purge</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Card>
          
          <Button 
            variant="outline"
            onClick={handleExportCSV}
            className="h-11 px-6 text-[10px] font-black uppercase tracking-widest gap-2 hover:bg-primary hover:text-primary-foreground border-muted-foreground/20 shadow-xs transition-all active:scale-95"
          >
            <Download className="size-4" />
            Export CSV
          </Button>

          {/* operator ดู log ได้แต่ล้างไม่ได้ — ซ่อนปุ่มไปเลยแทนที่จะโชว์แล้วให้กดจนโดน 403
              (backend ยังกัน /api/logs/clear ด้วย isAdmin อยู่ ตรงนี้เป็นแค่การไม่หลอกตา) */}
          {canPurgeLogs && (
            <Button
              variant="destructive"
              onClick={handleClearLogs}
              className="h-11 px-6 text-[10px] font-black uppercase tracking-widest gap-2 shadow-xl shadow-destructive/10 transition-all active:scale-95"
            >
              <Trash2 className="size-4" />
              Purge Logs
            </Button>
          )}
        </div>
      </div>

      {/* Audit Database Table */}
      <Card className="border shadow-md overflow-hidden bg-card/50 backdrop-blur-xs">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/40 border-b">
              <TableRow>
                <TableHead className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Chronology</TableHead>
                <TableHead className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Classification</TableHead>
                <TableHead className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Principal</TableHead>
                <TableHead className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Action Metadata</TableHead>
                <TableHead className="px-6 py-5 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Operation Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length > 0 ? logs.map((log, i) => {
                const category = getLogCategory(log.action);
                return (
                  <TableRow key={i} className="group hover:bg-muted/30 transition-all border-b border-muted/50">
                    <TableCell className="px-6 py-4">
                       <div className="flex flex-col gap-0.5">
                          <span className="text-[12px] font-black font-mono tracking-tighter">
                             {formatThaiTime(log.timestamp)}
                          </span>
                          <span className="text-[9px] font-bold text-muted-foreground opacity-60">
                             {formatThaiDate(log.timestamp, 'SYSTEM_TIME')}
                          </span>
                       </div>
                    </TableCell>
                    <TableCell className="px-6 py-4">
                       <div className={cn(
                          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[9px] font-black uppercase tracking-widest",
                          category.variant === 'destructive' ? "bg-destructive/10 text-destructive border-destructive/20" : 
                          category.variant === 'secondary' ? "bg-muted text-foreground border-muted-foreground/20" : 
                          category.variant === 'default' ? "bg-primary/5 text-primary border-primary/20" : 
                          "bg-card text-muted-foreground border-border"
                       )}>
                          {category.icon}
                          {category.label}
                       </div>
                    </TableCell>
                    <TableCell className="px-6 py-4">
                       <div className="flex items-center gap-2.5">
                          <div className="size-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-black border border-primary/5 shadow-inner uppercase">
                             {log.username?.charAt(0) || log.user?.charAt(0) || 'S'}
                          </div>
                          <span className="text-[11px] font-black uppercase tracking-tight">
                             {log.username || log.user || 'SYSTEM'}
                          </span>
                       </div>
                    </TableCell>
                    <TableCell className="px-6 py-4">
                       <Badge variant="outline" className="bg-background/50 font-black text-[9px] uppercase tracking-tighter px-2 h-5">
                          {log.action || 'EVENT'}
                       </Badge>
                    </TableCell>
                    <TableCell className="px-6 py-4">
                       <div className="flex items-center justify-between gap-4">
                          <p className="text-[13px] font-medium tracking-tight text-foreground/80 group-hover:text-foreground transition-colors leading-relaxed">
                            {log.details?.split(' | ')[0]}
                          </p>
                          {log.details?.includes(' | ') && (
                            <Button 
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                 const parts = log.details.split(' | ');
                                 if (parts[1]) setSelectedEventImage(`${parts[1]}`);
                              }}
                              className="h-8 text-[10px] font-black gap-2 bg-card hover:bg-primary hover:text-primary-foreground border-muted-foreground/20 shadow-xs uppercase tracking-widest px-4"
                            >
                              <ImageIcon className="size-3.5" />
                              Inspect
                            </Button>
                          )}
                       </div>
                    </TableCell>
                  </TableRow>
                );
              }) : (
                <TableRow>
                  <TableCell colSpan="5" className="px-6 py-40 text-center opacity-30">
                     <div className="flex flex-col items-center gap-4">
                        <Database className="size-12 animate-pulse" />
                        <div className="space-y-1">
                           <p className="text-sm font-black uppercase tracking-[0.4em]">No Logs Recovered</p>
                           <p className="text-[10px] font-bold uppercase tracking-widest">Database entry synchronization pending</p>
                        </div>
                     </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
};

export default EventLogs;
