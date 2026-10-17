using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace SurveillanceGateway.Client.Services;

public sealed class MonitorWallPlacement
{
    public string Monitor { get; set; } = "";
    public string ViewId { get; set; } = "";
    public string ProfileId { get; set; } = "";
    public double Left { get; set; }
    public double Top { get; set; }
    public double Width { get; set; } = 1100;
    public double Height { get; set; } = 760;
    public bool HasBounds { get; set; }
}

public static class MonitorLayout
{
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct Info {
        public int Size; public Rect Monitor, Work; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Device;
    }
    private delegate bool Callback(IntPtr monitor, IntPtr hdc, ref Rect rectangle, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, Callback callback, IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref Info info);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rectangle);
    public sealed record Screen(string Device, Rect Work) { public override string ToString() => Device; }
    // เก็บพิกัด monitor เป็น physical pixels และวางหน้าต่างผ่าน Win32 เพื่อรองรับ DPI ต่างกัน
    public static List<Screen> Screens()
    {
        var result = new List<Screen>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr monitor, IntPtr hdc, ref Rect rect, IntPtr data) => {
            var info = new Info { Size = Marshal.SizeOf<Info>(), Device = "" };
            if (GetMonitorInfo(monitor, ref info)) result.Add(new Screen(info.Device, info.Work)); return true;
        }, IntPtr.Zero); return result;
    }
    // คืนพิกัดที่เข้าถึงได้บนจอปัจจุบัน แม้จอเดิมหายหรือ resolution เปลี่ยน
    public static Rect Clamp(Screen screen, MonitorWallPlacement? saved)
    {
        var r=screen.Work;if(saved is null || !saved.HasBounds) return r;
        if(!double.IsFinite(saved.Left)||!double.IsFinite(saved.Top)||!double.IsFinite(saved.Width)||!double.IsFinite(saved.Height)) return r;
        var width=(int)Math.Clamp(saved.Width,Math.Min(720,r.Right-r.Left),r.Right-r.Left);
        var height=(int)Math.Clamp(saved.Height,Math.Min(480,r.Bottom-r.Top),r.Bottom-r.Top);
        var left=(int)Math.Clamp(saved.Left,r.Left,r.Right-width);var top=(int)Math.Clamp(saved.Top,r.Top,r.Bottom-height);
        return new Rect { Left=left,Top=top,Right=left+width,Bottom=top+height };
    }
    public static void Capture(Window window, MonitorWallPlacement placement)
    {
        if(!GetWindowRect(new WindowInteropHelper(window).Handle,out var r)) return;
        var screen=Screens().OrderByDescending(s=>Math.Max(0,Math.Min(s.Work.Right,r.Right)-Math.Max(s.Work.Left,r.Left))*
            (long)Math.Max(0,Math.Min(s.Work.Bottom,r.Bottom)-Math.Max(s.Work.Top,r.Top))).FirstOrDefault();
        if(screen is not null) placement.Monitor=screen.Device;
        placement.Left=r.Left;placement.Top=r.Top;placement.Width=r.Right-r.Left;placement.Height=r.Bottom-r.Top;placement.HasBounds=true;
    }
    public static void Place(Window window, Screen screen, MonitorWallPlacement? saved = null)
    {
        window.WindowState = WindowState.Normal;
        var r = Clamp(screen,saved);
        SetWindowPos(new WindowInteropHelper(window).Handle, IntPtr.Zero, r.Left, r.Top, r.Right-r.Left, r.Bottom-r.Top, 0x0014);
    }
}
