import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FolderPen } from "lucide-react";

/**
 * RenameGroupModal - หน้าต่างป๊อปอัพเปลี่ยนชื่อกลุ่มกล้อง สไตล์ Monochrome Shadcn
 * รองรับภาษาไทยและมีการจัดการอนิเมชันที่สวยงามค่ะ
 */
const RenameGroupModal = ({
  isOpen,
  onClose,
  oldName,
  onRename,
  isLoading
}) => {
  const [newName, setNewName] = useState('');
  const [syncedName, setSyncedName] = useState(null);

  // ซิงค์ชื่อกลุ่มเก่ามาใส่เมื่อเปิดโมดอล — ทำตอน render แทน effect (ปิดแล้วเปิดใหม่ก็รีเซ็ต)
  const openName = isOpen ? (oldName || '') : null;
  if (openName !== syncedName) {
    setSyncedName(openName);
    if (openName !== null) setNewName(openName);
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!newName || newName.trim() === '' || newName.trim() === oldName) {
      onClose();
      return;
    }
    onRename(newName.trim());
  };

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent showCloseButton={false} className="max-w-md border-none shadow-2xl bg-card font-sans p-0 overflow-hidden">
        {/* Header */}
        <div className="p-6 border-b bg-muted/20 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-lg">
              <FolderPen className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold tracking-tight uppercase">
                Rename Camera Group
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5 uppercase tracking-wide">
                Modify Directory / Group Identification
              </DialogDescription>
            </div>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-4">
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground ml-1">
                เปลี่ยนชื่อกลุ่มกล้องจาก <span className="font-bold text-foreground">"{oldName}"</span> เป็น:
              </Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="h-11 font-medium text-sm"
                placeholder="กรอกชื่อกลุ่มกล้องใหม่..."
                autoFocus
              />
            </div>
          </div>

          {/* Footer Actions */}
          <div className="p-6 bg-muted/20 border-t flex justify-end gap-3 shrink-0">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="px-6 text-xs font-bold opacity-60 hover:opacity-100 uppercase"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isLoading || !newName.trim() || newName.trim() === oldName}
              className="px-8 h-11 text-xs font-bold tracking-wider shadow-xl min-w-[120px] uppercase"
            >
              {isLoading ? "Saving..." : "Rename"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default RenameGroupModal;
