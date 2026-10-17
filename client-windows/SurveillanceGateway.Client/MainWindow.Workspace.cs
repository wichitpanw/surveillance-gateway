using System;
using System.Windows;
using System.Windows.Input;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;
using SurveillanceGateway.Client.Views;

namespace SurveillanceGateway.Client;

public partial class MainWindow
{
    // ใช้ resource เดียวกันทั้ง workspace เพื่อเปลี่ยนความหนาแน่นโดยไม่สร้าง player ใหม่
    private void InitialiseWorkspace()
    {
        ApplyWorkspaceDensity();
        DensityButton.Click += (_, _) => {
            _settings.WorkspaceDensity = _settings.WorkspaceDensity == "comfortable" ? "compact" : "comfortable";
            ApplyWorkspaceDensity(); _settings.Save();
        };
        Strings.Current.PropertyChanged += OnWorkspaceLanguage;
        Closed += (_, _) => Strings.Current.PropertyChanged -= OnWorkspaceLanguage;
        PreviewKeyDown += (_, e) => {
            if (e.Key != Key.F || Keyboard.Modifiers != ModifierKeys.Control) return;
            if (Selected?.Kind == PageKind.Wall) _wall?.FocusCameraSearch();
            else if (Selected?.Kind == PageKind.Playback) _playbackView?.FocusCameraSearch();
            else return;
            e.Handled = true;
        };
    }

    private void OnWorkspaceLanguage(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => Dispatcher.InvokeAsync(ApplyWorkspaceDensity);

    // ไม่ลดขนาด glyph หรือปุ่มควบคุมวิดีโอจนกดลำบาก ใช้ density กับ typography และขอบ workspace
    private void ApplyWorkspaceDensity()
    {
        var compact = _settings.WorkspaceDensity != "comfortable";
        var resources = Application.Current.Resources;
        resources["FontSizeBase"] = compact ? 12.5 : 14.0;
        resources["FontSizeSmall"] = compact ? 11.5 : 12.5;
        resources["FontSizeTiny"] = compact ? 10.5 : 11.5;
        resources["WorkspaceMargin"] = new Thickness(compact ? 8 : 14);
        DensityButton.Content = Strings.T(compact ? "workspace.compact" : "workspace.comfortable");
    }

    // เปลี่ยน workspace โดยส่งกล้องเดิมกลับไปยัง wall ไม่สร้างหน้าต่าง player เพิ่ม
    private async void OnWorkspaceLive(object? sender, V1Camera camera)
    {
        try
        {
            Select(PageKind.Wall);
            if (_wall is not null) await _wall.OpenWorkspaceCameraAsync(camera.Id);
        }
        catch (Exception ex) { App.LogError("WorkspaceLive", ex); StatusText.Text = Strings.T("workspace.navigationFailed"); }
    }

    // ผูกทุกครั้งที่สร้าง Wall เพื่อให้ปิดและเปิดแท็บใหม่แล้วยังส่งบริบทได้
    private async void OnWorkspacePlayback(object? sender, V1Camera camera)
    {
        try
        {
            if (_home is null) return;
            Select(PageKind.Playback);
            if (_playbackView is not null) await _playbackView.SelectWorkspaceCameraAsync(camera);
        }
        catch (Exception ex) { App.LogError("WorkspacePlayback", ex); StatusText.Text = Strings.T("workspace.navigationFailed"); }
    }
}
