using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Data;
using System.Windows.Threading;
using Microsoft.Win32;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

public sealed class DiagnosticsWindow : Window
{
    private readonly Func<IEnumerable<StreamDiagnostic>> _capture;
    private readonly DataGrid _report = new() { IsReadOnly = true, AutoGenerateColumns = false,
        CanUserAddRows = false, CanUserDeleteRows = false, HeadersVisibility = DataGridHeadersVisibility.Column,
        GridLinesVisibility = DataGridGridLinesVisibility.Horizontal, RowHeight = 40 };
    private readonly TextBlock _summary = new() { Margin=new Thickness(0,0,0,12) };
    private readonly TextBlock _note = new() { TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,0,0,12) };
    private readonly Button _export = new() { Margin=new Thickness(0,12,0,0),Padding=new Thickness(12,8,12,8) };
    private TimeSpan _lastCpu;
    private DateTime _lastAt=DateTime.UtcNow;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(2) };
    // หน้ารายงานแยกจาก HWND วิดีโอ จึงไม่รบกวนภาพหรือการควบคุม PTZ
    public DiagnosticsWindow(Func<IEnumerable<StreamDiagnostic>> capture)
    {
        _capture = capture; Title = Strings.T("diagnostic.title"); Width = 800; Height = 600;
        MinWidth = 420; MinHeight = 280; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        SetResourceReference(BackgroundProperty, "SurfaceBrush"); SetResourceReference(ForegroundProperty, "ForegroundBrush");
        SetResourceReference(FontFamilyProperty,"UiFont");
        var panel = new DockPanel { Margin = new Thickness(16) };
        DockPanel.SetDock(_note,Dock.Top);panel.Children.Add(_note);
        DockPanel.SetDock(_summary,Dock.Top);panel.Children.Add(_summary);
        DockPanel.SetDock(_export,Dock.Bottom);panel.Children.Add(_export);panel.Children.Add(_report);Content=panel;
        _report.SetResourceReference(BackgroundProperty,"BackgroundBrush");_report.SetResourceReference(ForegroundProperty,"ForegroundBrush");
        _note.SetResourceReference(TextBlock.ForegroundProperty,"ForegroundBrush");_summary.SetResourceReference(TextBlock.ForegroundProperty,"ForegroundBrush");
        _report.SetResourceReference(DataGrid.RowBackgroundProperty,"SurfaceBrush");_report.SetResourceReference(DataGrid.HorizontalGridLinesBrushProperty,"BorderBrush");
        var header=new Style(typeof(DataGridColumnHeader));
        header.Setters.Add(new Setter(BackgroundProperty,new DynamicResourceExtension("SurfaceBrush")));
        header.Setters.Add(new Setter(ForegroundProperty,new DynamicResourceExtension("ForegroundBrush")));
        header.Setters.Add(new Setter(Control.PaddingProperty,new Thickness(8)));_report.ColumnHeaderStyle=header;
        _export.SetResourceReference(StyleProperty,"GhostButton");
        _export.Click += async (_, _) => {
            var dialog = new SaveFileDialog { FileName = "client-diagnostics.json", Filter = Strings.T("diagnostic.filter") };
            if (dialog.ShowDialog(this) != true) return;
            try { await File.WriteAllTextAsync(dialog.FileName, ClientDiagnostics.Serialize(_capture())); }
            catch (Exception ex) { _note.Text = Strings.T("diagnostic.failure", ex.GetType().Name); }
        };
        _timer.Tick += (_, _) => Refresh(); Closed += (_, _) => { _timer.Stop();Strings.Current.PropertyChanged-=LanguageChanged; };
        Strings.Current.PropertyChanged+=LanguageChanged;Labels();Refresh();_timer.Start();
    }
    private void LanguageChanged(object? sender,PropertyChangedEventArgs e) { Labels();Refresh(); }
    private void Labels()
    {
        Title=Strings.T("diagnostic.title");_note.Text=Strings.T("diagnostic.note");_export.Content=Strings.T("diagnostic.export");
        _report.Columns.Clear();
        foreach(var (key,property) in new[]{("camera","CameraId"),("stream","Stream"),("state","State"),("codec","Codec"),("size","Resolution"),("fps","Fps"),("lost","LostPictures"),("retry","Reconnects"),("fallback","Fallback"),("error","LastError")})
            _report.Columns.Add(new DataGridTextColumn { Header=Strings.T("diagnostic."+key),Binding=new Binding(property),MinWidth=70 });
    }
    private void Refresh()
    {
        var rows=_capture().ToArray();
        _report.ItemsSource=rows.Select(r=>new { r.CameraId,r.Stream,State=Strings.TOr("diagnostic.state."+r.State,r.State),r.Codec,
            Resolution=$"{r.Width} × {r.Height}",Fps=r.Fps.ToString("0.#"),r.LostPictures,r.Reconnects,
            Fallback=Strings.T(r.Fallback?"diagnostic.yes":"diagnostic.no"),r.LastError }).ToArray();
        using var process=Process.GetCurrentProcess();var now=DateTime.UtcNow;var cpu=process.TotalProcessorTime;
        var percent=(cpu-_lastCpu).TotalSeconds/Math.Max(.1,(now-_lastAt).TotalSeconds)/Environment.ProcessorCount*100;
        if(_lastCpu==TimeSpan.Zero)percent=0;_lastCpu=cpu;_lastAt=now;
        _summary.Text=Strings.T("monitor.resources",process.WorkingSet64/1000000.0,percent);
    }
}
