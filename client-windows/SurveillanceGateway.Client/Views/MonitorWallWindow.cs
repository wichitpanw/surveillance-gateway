using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Threading;
using LibVLCSharp.Shared;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

public sealed class MonitorWallWindow : Window
{
    private static readonly List<MonitorWallWindow> Active = new();
    private readonly VideoWallView _wall;
    private readonly DispatcherTimer _resources = new() { Interval = TimeSpan.FromSeconds(2) };
    private readonly Process _process = Process.GetCurrentProcess();
    private TimeSpan _lastCpu;
    private DateTime _lastAt = DateTime.UtcNow;
    private readonly AppSettings _settings;
    private readonly MonitorWallPlacement _placement;
    private bool _loading;
    // ทุกหน้าต่างมี wall/decoder ของตัวเองและปิดทั้งหมดเมื่อ shell ออกจากระบบ
    private MonitorWallWindow(GatewayClient client, AppSettings settings, LibVLC vlc, MonitorWallPlacement placement)
    {
        _settings = settings; _placement = placement;
        Title = Strings.T("monitor.title"); Width = 1100; Height = 760;
        MinWidth = 720; MinHeight = 480; SetResourceReference(BackgroundProperty, "BackgroundBrush");
        SetResourceReference(FontFamilyProperty,"UiFont");
        SetResourceReference(ForegroundProperty, "ForegroundBrush");
        var panel = new DockPanel(); var status = new TextBlock { Margin = new Thickness(12,6,12,6) };
        DockPanel.SetDock(status, Dock.Bottom); panel.Children.Add(status);
        _wall = new VideoWallView(client, settings, vlc); panel.Children.Add(_wall); Content = panel;
        _lastCpu = _process.TotalProcessorTime;
        _resources.Tick += (_, _) => { _process.Refresh(); var now=DateTime.UtcNow;var cpu=_process.TotalProcessorTime;
            var percent=(cpu-_lastCpu).TotalSeconds/Math.Max(.1,(now-_lastAt).TotalSeconds)/Environment.ProcessorCount*100;
            _lastCpu=cpu;_lastAt=now;status.Text=Strings.T("monitor.resources",_process.WorkingSet64/1000000.0,percent); };
        Loaded += async (_, _) => {
            _loading=true;
            try {
                var screens=MonitorLayout.Screens();var screen=screens.FirstOrDefault(s=>s.Device==placement.Monitor)??screens.FirstOrDefault();
                if(screen is not null) MonitorLayout.Place(this,screen,placement);
                await _wall.InitialiseAsync();
                if(IsVisible) await _wall.OpenSavedViewAsync(placement.ViewId);
                if(IsVisible) _resources.Start();
            } catch(Exception ex) { status.Text=Strings.T("monitor.failure",ex.GetType().Name); }
            finally { _loading=false; }
        };
        SourceInitialized += (_, _) => HwndSource.FromHwnd(new WindowInteropHelper(this).Handle)?.AddHook(DisplayHook);
        Closed += (_, _) => { _resources.Stop();_wall.Dispose();_process.Dispose();Active.Remove(this);
            if(!_loading) settings.Save(); };
        Closing += (_, _) => { if(!_loading) MonitorLayout.Capture(this,placement); };
    }
    // จอถูกถอดต้องคืนหน้าต่างให้อยู่บนจอที่ยังเข้าถึงได้ โดยไม่ย้ายไปเองจาก WM_DPICHANGED
    private IntPtr DisplayHook(IntPtr hwnd,int message,IntPtr w,IntPtr l,ref bool handled)
    {
        if(message==0x007E) Dispatcher.BeginInvoke(()=>{
            if(!IsVisible) return;
            var screens=MonitorLayout.Screens();if(screens.All(s=>s.Device!=_placement.Monitor)&&screens.FirstOrDefault() is {} screen) MonitorLayout.Place(this,screen);
        });return IntPtr.Zero;
    }
    public static void CloseAll() { foreach(var wall in Active.ToArray()) wall.Close(); }
    public static void Restore(GatewayClient client,AppSettings settings,LibVLC vlc,Window owner)
    {
        if(!settings.RestoreMonitorWalls) return;
        foreach(var p in settings.MonitorWalls.Where(p=>p.ProfileId==settings.ActiveProfileId).ToArray()) ShowWall(client,settings,vlc,owner,p);
    }
    private static void ShowWall(GatewayClient client,AppSettings settings,LibVLC vlc,Window? owner,MonitorWallPlacement p)
    {
        var current=Active.FirstOrDefault(a=>a._placement.Monitor==p.Monitor && a._placement.ProfileId==p.ProfileId);
        if(current is not null && current._placement.ViewId==p.ViewId) { current.Activate();return; }
        if(current is not null) { current.Close(); }
        var window=new MonitorWallWindow(client,settings,vlc,p);if(owner is not null)window.Owner=owner;
        Active.Add(window);window.Show();
    }
    public static void Open(GatewayClient client,AppSettings settings,LibVLC vlc,Window? owner)
    {
        var dialog=new Window { Title=Strings.T("monitor.title"),Width=460,Height=320,Owner=owner,WindowStartupLocation=WindowStartupLocation.CenterOwner };
        dialog.SetResourceReference(BackgroundProperty,"SurfaceBrush");dialog.SetResourceReference(ForegroundProperty,"ForegroundBrush");
        dialog.SetResourceReference(FontFamilyProperty,"UiFont");
        var panel=new StackPanel { Margin=new Thickness(20) }; var screen=new ComboBox { ItemsSource=MonitorLayout.Screens(),SelectedIndex=0,Margin=new Thickness(0,6,0,12) };
        var view=new ComboBox { ItemsSource=settings.WallViews,SelectedIndex=0,Margin=new Thickness(0,6,0,12) };
        panel.Children.Add(new TextBlock { Text=Strings.T("monitor.screen") });panel.Children.Add(screen);
        panel.Children.Add(new TextBlock { Text=Strings.T("monitor.view") });panel.Children.Add(view);
        var restore=new CheckBox { Content=Strings.T("monitor.restore"),IsChecked=settings.RestoreMonitorWalls,Margin=new Thickness(0,0,0,12) };panel.Children.Add(restore);
        var open=new Button { Content=Strings.T(settings.WallViews.Count==0?"monitor.empty":"monitor.open"),IsEnabled=settings.WallViews.Count>0 };
        panel.Children.Add(open);dialog.Content=panel;
        open.Click+=(_,_)=>{
            if(screen.SelectedItem is not MonitorLayout.Screen s || view.SelectedItem is not WallView v) return;
            var p=settings.MonitorWalls.FirstOrDefault(p=>p.Monitor==s.Device && p.ProfileId==settings.ActiveProfileId);
            if(p is null) { p=new MonitorWallPlacement { Monitor=s.Device,ProfileId=settings.ActiveProfileId??"" };settings.MonitorWalls.Add(p); }
            if(p.ViewId!=v.Id) {
                var active=Active.FirstOrDefault(a=>ReferenceEquals(a._placement,p));active?.Close();
            }
            p.ViewId=v.Id;settings.RestoreMonitorWalls=restore.IsChecked==true;settings.Save();dialog.Close();ShowWall(client,settings,vlc,owner,p);
        };dialog.ShowDialog();
    }
}
