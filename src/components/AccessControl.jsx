import React, { useState } from 'react';
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UserPlus, UserCog, Trash2, Shield, ShieldCheck, Users, KeyRound, Plus, Lock } from "lucide-react";
import { isSuperAdmin, isLastElevatedUser } from '@/lib/roles';
import { useLanguage } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { roleScopeLabel } from '@/lib/role-scope';

/**
 * Access Control Component - Monochrome Shadcn Style
 * มี 2 แท็บ: Users (ผู้ใช้) และ Roles (สิทธิ์แบบสร้างเอง)
 */
const AccessControl = ({
  users,
  loggedInUser,
  setUserModalMode,
  setUserFormData,
  setIsUserModalOpen,
  handleDeleteUser,
  roles = [],
  onOpenRoleModal,
  onDeleteRole,
}) => {
  const { t } = useLanguage();
  const [panel, setPanel] = useState('users');
  const roleOf = (u) => roles.find((x) => x.id === u.role_id) || roles.find((x) => x.name === u.role);
  const roleLabelOf = (u) => roleOf(u)?.label || u.role;
  // "elevated look" = role นี้มีสิทธิ์จัดการผู้ใช้ (ใช้ข้อมูลจริง ไม่ผูกชื่อ role)
  const roleElevated = (u) => (roleOf(u)?.permissions || []).includes('user.manage');
  const openEdit = (u) => {
    setUserModalMode('edit');
    // ไม่ส่ง password เข้าฟอร์ม — ฝั่ง backend คืนค่ามาแบบไม่มี password อยู่แล้ว แต่กันไว้อีกชั้น
    setUserFormData({ ...u, password: '' });
    setIsUserModalOpen(true);
  };

  const canDelete = (u) => {
    if (u.id === loggedInUser?.id) return false;
    if (isLastElevatedUser(users, u)) return false;
    if (isSuperAdmin(u.role) && !isSuperAdmin(loggedInUser?.role)) return false;
    return true;
  };

  return (
    <div className="flex flex-col gap-6 animate-fade-in font-sans pb-10">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 px-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Access Control</h2>
          <p className="text-muted-foreground text-sm font-medium">{t('accessControlDek')}</p>
        </div>
        {panel === 'users' ? (
          <Button
            onClick={() => {
              setUserModalMode('add');
              setUserFormData({ id: '', username: '', password: '', role: 'monitor', role_id: 'r_monitor', allowedCameras: [] });
              setIsUserModalOpen(true);
            }}
            className="h-11 px-6 text-xs font-bold uppercase tracking-widest gap-2 shadow-sm"
          >
            <UserPlus className="size-4" />
            Create User
          </Button>
        ) : (
          <Button
            onClick={() => onOpenRoleModal?.('add', null)}
            className="h-11 px-6 text-xs font-bold uppercase tracking-widest gap-2 shadow-sm"
          >
            <Plus className="size-4" />
            Create Role
          </Button>
        )}
      </div>

      {/* แท็บ Users / Roles */}
      <div className="flex gap-1 border-b px-2">
        {[{ id: 'users', label: 'Users', icon: Users }, { id: 'roles', label: 'Roles', icon: KeyRound }].map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setPanel(tb.id)}
            className={cn(
              'px-4 py-2 text-[11px] font-black uppercase tracking-wider border-b-2 -mb-px flex items-center gap-2 transition-colors',
              panel === tb.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <tb.icon className="size-3.5" />
            {tb.label}
            <Badge variant="outline" className="h-4 text-[8px] font-mono">{tb.id === 'users' ? users.length : roles.length}</Badge>
          </button>
        ))}
      </div>

      {panel === 'roles' && (
        <Card className="border shadow-sm overflow-hidden bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest">Role</TableHead>
                  <TableHead className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest">Permissions</TableHead>
                  <TableHead className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest">Devices</TableHead>
                  <TableHead className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest">Users</TableHead>
                  <TableHead className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.map((r) => (
                  <TableRow key={r.id} className="group hover:bg-muted/30 transition-colors">
                    <TableCell className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {r.is_system ? <Lock className="size-3.5 text-purple-500" /> : <KeyRound className="size-3.5 text-muted-foreground" />}
                        <span className="text-sm font-bold uppercase tracking-tight">{r.label || r.name}</span>
                        {r.is_system && <Badge variant="outline" className="h-4 text-[8px] font-mono">SYSTEM</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="px-6 py-4 text-xs font-mono text-muted-foreground">{(r.permissions || []).length} perms</TableCell>
                    <TableCell className="px-6 py-4 text-xs text-muted-foreground">
                      {roleScopeLabel(r)}
                    </TableCell>
                    <TableCell className="px-6 py-4 text-xs font-mono">{r.userCount ?? 0}</TableCell>
                    <TableCell className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="outline" size="sm"
                          onClick={() => onOpenRoleModal?.('edit', r)}
                          className="h-8 text-[10px] font-bold uppercase tracking-widest gap-2 opacity-60 group-hover:opacity-100 transition-opacity"
                        >
                          <UserCog className="size-3.5" />
                          {r.is_system ? 'View' : 'Edit'}
                        </Button>
                        <Button
                          variant="outline" size="sm"
                          disabled={r.is_system || (r.userCount ?? 0) > 0}
                          title={r.is_system ? 'System role' : ((r.userCount ?? 0) > 0 ? 'ยังมีผู้ใช้ role นี้อยู่' : undefined)}
                          onClick={() => onDeleteRole?.(r)}
                          className="h-8 text-[10px] font-bold uppercase tracking-widest gap-2 opacity-60 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive disabled:opacity-30"
                        >
                          <Trash2 className="size-3.5" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {/* Users Table Card */}
      {panel === 'users' && (
      <Card className="border shadow-sm overflow-hidden bg-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest">User Details</TableHead>
                <TableHead className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest">Role</TableHead>
                <TableHead className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest">Access Scope</TableHead>
                <TableHead className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map(u => {
                const deletable = canDelete(u);
                const deleteDisabledReason = u.id === loggedInUser?.id
                  ? t('cantDeleteSelf')
                  : (isLastElevatedUser(users, u) ? t('needAtLeastOneAdmin') : '');
                return (
                <TableRow key={u.id} className="group hover:bg-muted/30 transition-colors">
                  <TableCell className="px-6 py-4">
                    <div className="flex items-center gap-4">
                      <div className="size-10 rounded-lg bg-primary flex items-center justify-center font-bold text-primary-foreground shadow-sm">
                        {u.username.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-sm font-bold tracking-tight">{u.username.toUpperCase()}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">UID: {u.id || 'N/A'}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="px-6 py-4">
                    <Badge
                      variant={roleElevated(u) ? "default" : "secondary"}
                      className={`text-[10px] font-black uppercase rounded-md px-2 py-0 ${isSuperAdmin(u.role) ? 'bg-purple-600 hover:bg-purple-700 text-white border-transparent' : ''}`}
                    >
                      {isSuperAdmin(u.role) ? <ShieldCheck className="size-3 mr-1 text-purple-200" /> : (roleElevated(u) ? <ShieldCheck className="size-3 mr-1" /> : <Shield className="size-3 mr-1" />)}
                      {roleLabelOf(u)}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-6 py-4">
                    <span className="text-xs font-medium text-muted-foreground">
                      {roleScopeLabel(roleOf(u))}
                    </span>
                  </TableCell>
                  <TableCell className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openEdit(u)}
                        className="h-8 text-[10px] font-bold uppercase tracking-widest gap-2 opacity-60 group-hover:opacity-100 transition-opacity"
                      >
                        <UserCog className="size-3.5" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!deletable}
                        title={deletable ? undefined : deleteDisabledReason}
                        onClick={() => handleDeleteUser(u)}
                        className="h-8 text-[10px] font-bold uppercase tracking-widest gap-2 opacity-60 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive disabled:opacity-30"
                      >
                        <Trash2 className="size-3.5" />
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                );
              })}
              {users.length === 0 && (
                <TableRow>
                  <TableCell colSpan="4" className="px-6 py-20 text-center opacity-30">
                     <div className="flex flex-col items-center gap-3">
                        <Users className="size-10" />
                        <p className="text-xs font-bold uppercase tracking-[0.2em]">{t('noUsersRegistered')}</p>
                     </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
      )}
    </div>
  );
};

export default AccessControl;
