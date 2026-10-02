import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { UserCog, Shield, Key } from "lucide-react";
import { isSuperAdmin, isLastElevatedUser } from "@/lib/roles";
import { roleScopeLabel } from '@/lib/role-scope';

/**
 * User Modal - ส่วนจัดการผู้ใช้งานสไตล์ Monochrome Shadcn
 * แก้ไขปัญหาการ Scroll และเพิ่ม Description เพื่อความถูกต้องของระบบค่ะ
 * หมายเหตุ: ลบผู้ใช้ทำจากตาราง (AccessControl.jsx) โดยตรงแล้ว modal นี้จึงไม่มีปุ่มลบอีกต่อไป
 */
const UserModal = ({
  isUserModalOpen,
  userModalMode,
  userFormData,
  setUserFormData,
  loggedInUser,
  users,
  handleSaveUser,
  setIsUserModalOpen,
  isLoading,
  roles = [],
}) => {
  // role ที่ผู้ใช้ปัจจุบันตั้งให้คนอื่นได้: superadmin ตั้งได้ทุก role, คนอื่นตั้งได้ทุก role ยกเว้น superadmin
  const assignableRoles = roles.filter((r) => r.name !== 'superadmin' || isSuperAdmin(loggedInUser?.role));

  if (!isUserModalOpen) return null;

  return (
    <Dialog open={isUserModalOpen} onOpenChange={setIsUserModalOpen}>
      <DialogContent showCloseButton={false} className="w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col p-0 gap-0 border-none shadow-2xl bg-card font-sans">
        {/* Header */}
        <div className="p-6 border-b bg-muted/20 flex items-center justify-between shrink-0">
           <div className="flex items-center gap-3">
              <div className="size-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-lg">
                 <UserCog className="size-5" />
              </div>
              <div>
                 <DialogTitle className="text-xl font-black uppercase tracking-tighter">
                   {userModalMode === 'add' ? "Provision New Identity" : "Edit Identity"}
                 </DialogTitle>
                 <DialogDescription className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mt-0.5">
                   Access Control Infrastructure Configuration
                 </DialogDescription>
              </div>
           </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain border-b">
          <div className="p-8 space-y-8 pb-12">
            {/* Base Profile */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
               <div className="space-y-2">
                  <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Account Handle</Label>
                  <Input 
                    value={userFormData.username} 
                    onChange={e => setUserFormData({...userFormData, username: e.target.value})} 
                    className="h-11 font-bold uppercase text-xs" 
                    placeholder="USERNAME"
                    disabled={userModalMode === 'edit'} 
                  />
               </div>
               <div className="space-y-2">
                  <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Access Authorization Level</Label>
                  {(() => {
                    const isSelf = userModalMode === 'edit' && userFormData.id === loggedInUser?.id;
                    const isLastAdmin = userModalMode === 'edit' && isLastElevatedUser(users, userFormData);
                    const roleLocked = isSelf || isLastAdmin;
                    const roleLockReason = isSelf ? 'เปลี่ยน role ของตัวเองไม่ได้' : (isLastAdmin ? 'ต้องมี admin/superadmin เหลืออย่างน้อย 1 คน' : '');
                    return (
                      <>
                        <Select
                          value={userFormData.role_id || (userFormData.role ? `r_${userFormData.role}` : '')}
                          onValueChange={(val) => {
                            // เก็บทั้ง role_id (ตัวจริงที่ backend ใช้) และ role name (เผื่อ UI เดิม)
                            const r = roles.find((x) => x.id === val);
                            setUserFormData({ ...userFormData, role_id: val, role: r?.name || val.replace(/^r_/, '') });
                          }}
                          disabled={roleLocked}
                        >
                          <SelectTrigger className="h-11 font-black uppercase text-[10px] tracking-widest" title={roleLocked ? roleLockReason : undefined}>
                             <SelectValue placeholder="Select Role" />
                          </SelectTrigger>
                          <SelectContent>
                             {assignableRoles.map((r) => (
                               <SelectItem key={r.id} value={r.id}>
                                 {(r.label || r.name).toUpperCase()}{r.is_system ? ' (SYSTEM)' : ''}
                               </SelectItem>
                             ))}
                          </SelectContent>
                        </Select>
                        {roleLocked && (
                          <p className="text-[9px] text-muted-foreground ml-1">{roleLockReason}</p>
                        )}
                      </>
                    );
                  })()}
               </div>
            </div>

            <div className="space-y-2">
               <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-1">Security Passkey</Label>
               <div className="relative">
                  <Input
                    type="password"
                    value={userFormData.password}
                    onChange={e => setUserFormData({...userFormData, password: e.target.value})}
                    className="h-11 font-bold text-sm tracking-widest pr-10"
                    placeholder={userModalMode === 'edit' ? 'เว้นว่างไว้เพื่อไม่เปลี่ยนรหัสผ่าน' : '••••••••••••'}
                  />
                  <Key className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground opacity-40" />
               </div>
            </div>

            {/* สิทธิ์กล้องย้ายไปอยู่ที่ role แล้ว (แบบ DSS) — ตั้งที่หน้า Roles ไม่ใช่รายคน
                ตรงนี้แค่บอกให้ผู้ใช้รู้ว่ากล้องที่คนนี้เห็นขึ้นกับ role ที่เลือกด้านบน */}
            <div className="pt-4 border-t">
              <div className="flex items-start gap-3 p-3 rounded-md bg-muted/30 border">
                <Shield className="size-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Device access</span>
                  <span className="text-[11px] text-muted-foreground">
                    {(() => {
                      const r = roles.find((x) => x.id === (userFormData.role_id || `r_${userFormData.role}`));
                      if (!r) return 'กำหนดตาม role ที่เลือก';
                      return `ขอบเขตของ role: ${roleScopeLabel(r)} — แก้ได้ที่แท็บ Roles`;
                    })()}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 bg-muted/20 flex flex-col sm:flex-row justify-end items-center gap-4 shrink-0 border-t">
           <div className="flex gap-3 w-full sm:w-auto">
              <Button 
                variant="ghost" 
                onClick={() => setIsUserModalOpen(false)}
                className="flex-1 sm:flex-none px-8 text-[11px] font-black uppercase tracking-widest opacity-60 hover:opacity-100"
              >
                Abort
              </Button>
              <Button 
                onClick={handleSaveUser} 
                disabled={isLoading}
                className="flex-1 sm:flex-none px-10 h-11 text-[11px] font-black uppercase tracking-[0.2em] shadow-xl min-w-[180px]"
              >
                {isLoading ? "SYNCING..." : "COMMIT CHANGES"}
              </Button>
           </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default UserModal;
