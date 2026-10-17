using System;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using SurveillanceGateway.Client.Models;

namespace SurveillanceGateway.Client.Views;

public partial class VideoWallView
{
    public event EventHandler<V1Camera>? PlaybackRequested;

    // Inspector เป็นช่อง Grid แยกจาก HWND วิดีโอ และไม่เปลี่ยนผังหรือเริ่ม decoder เอง
    private void InitialiseWorkspace()
    {
        WireRailSections();
        InspectorToggle.Checked += (_, _) => { InspectorColumn.Width = new GridLength(224); InspectorPanel.Visibility = Visibility.Visible; RefreshInspector(); };
        InspectorToggle.Unchecked += (_, _) => { InspectorPanel.Visibility = Visibility.Collapsed; InspectorColumn.Width = new GridLength(0); };
        CameraList.SelectionChanged += (_, _) => RefreshInspector(preferLibrary: true);
        InspectorPlayback.Click += (_, _) => { if (WorkspaceCamera is { } camera) PlaybackRequested?.Invoke(this, camera); };
        InspectorFocus.Click += (_, _) => { if (_selectedTile?.Camera is not null) ToggleFocusedCamera(_selectedTile); };
        SizeChanged += (_, _) => {
            InspectorToggle.IsEnabled = ActualWidth >= 1050;
            if (!InspectorToggle.IsEnabled && InspectorToggle.IsChecked == true) InspectorToggle.IsChecked = false;
        };
    }

    private V1Camera? _inspectorCamera;
    private V1Camera? WorkspaceCamera => _inspectorCamera;

    private void RefreshInspector(bool preferLibrary = false)
    {
        _inspectorCamera = preferLibrary ? CameraList.SelectedItem as V1Camera : SelectedCamera;
        var camera = _inspectorCamera;
        InspectorName.Text = camera?.DisplayName ?? SurveillanceGateway.Client.Services.Strings.T("workspace.select");
        InspectorGroup.Text = camera?.GroupLabel ?? "";
        InspectorState.Text = camera?.AvailabilityText ?? "";
        InspectorId.Text = camera?.GlobalId ?? camera?.Id ?? "";
        InspectorPlayback.IsEnabled = camera is not null && PlaybackRequested is not null;
        InspectorFocus.IsEnabled = _selectedTile?.Camera is not null && _selectedTile.Camera.Id == camera?.Id;
    }

    public void FocusCameraSearch() { CamerasHeader.IsChecked = true; LibraryControls.IsChecked = true; SearchBox.Focus(); SearchBox.SelectAll(); }

    // แถบซ้ายแบบ accordion: ส่วนกล้องกินพื้นที่ที่เหลือเมื่อเปิด เมื่อหุบให้ช่องว่างไปอยู่ใต้ PTZ แทน
    private void WireRailSections()
    {
        void Apply()
        {
            var open = CamerasHeader.IsChecked == true;
            CamerasRow.Height = open ? new GridLength(1, GridUnitType.Star) : GridLength.Auto;
            RailFillerRow.Height = open ? new GridLength(0) : new GridLength(1, GridUnitType.Star);
        }
        CamerasHeader.Checked += (_, _) => Apply();
        CamerasHeader.Unchecked += (_, _) => Apply();
        Apply();
    }

    // รอ catalog ก่อน resolve ID และใช้งานช่องที่เลือกเดิม ไม่ข้าม scope ด้วยข้อมูลจากหน้าอื่น
    public async Task OpenWorkspaceCameraAsync(string id)
    {
        if (_allCameras.Count == 0) await InitialiseAsync();
        if (_disposed || _renderingPage) return;
        var camera = _allCameras.FirstOrDefault(c => c.Id == id);
        if (camera is null) return;
        var assigned = _assignments.FindIndex(c => c == id);
        if (assigned >= 0 && _tiles.Count > 0 && assigned / _tiles.Count != _page)
            await GoToPageAsync(assigned / _tiles.Count);
        if (_disposed || _renderingPage) return;
        var existing = _tiles.FirstOrDefault(t => t.Camera?.Id == id);
        if (existing is not null) { SelectTile(existing); RefreshInspector(); return; }
        var empty = _tiles.FirstOrDefault(t => t.Camera is null);
        if (empty is null) { HintText.Text = SurveillanceGateway.Client.Services.Strings.T("workspace.wallFull"); return; }
        SelectTile(empty);
        CameraList.SelectedItem = camera;
        await AssignAsync(empty, camera);
        SelectTile(empty);
        RefreshInspector();
    }
}
