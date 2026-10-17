using System.Linq;
using System.Threading.Tasks;

namespace SurveillanceGateway.Client.Views;

public partial class VideoWallView
{
    private bool IsAutoTile(SurveillanceGateway.Client.Video.VideoTile tile)
    {
        var index = _page * _tiles.Count + _tiles.IndexOf(tile);
        return index >= 0 && index < _assignmentStreams.Count ? _assignmentStreams[index] == "auto" : _wallStream == "auto";
    }

    // หน้าต่างตรวจสตรีมของทุกช่องที่มีกล้อง ใช้ทั้งปุ่มบน wall และการ์ดบนหน้า Home
    public void ShowDiagnostics() =>
        new DiagnosticsWindow(() => _tiles.Where(t => t.Camera is not null).Select(t => t.CaptureDiagnostic()))
        { Owner = System.Windows.Window.GetWindow(this) }.Show();

    // เปิดเฉพาะ saved view ที่ผู้ใช้ระบุ ไม่เติมกล้องทั้งหมดให้เอง
    public async Task OpenSavedViewAsync(string id)
    {
        var view = _settings.WallViews.FirstOrDefault(v => v.Id == id);
        if (view is null || _disposed) return;
        _suppressViewChange = true; ViewBox.SelectedItem = view; _suppressViewChange = false;
        await LoadSelectedViewAsync();
    }
}
