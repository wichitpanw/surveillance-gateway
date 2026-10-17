using System;
using System.Windows;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

public partial class PlaybackView
{
    private double? _exportStart, _exportEnd;
    // ปุ่มใช้ตำแหน่งหัวเล่นบน timeline และตรวจช่วงซ้ำตอนดาวน์โหลดเพื่อไม่ตัดผ่านช่องว่างเงียบ ๆ
    private void OnMarkStart(object sender,RoutedEventArgs e) { _exportStart=CurrentSecond() ?? _position;UpdateExportSelection(); }
    private void OnMarkEnd(object sender,RoutedEventArgs e) { _exportEnd=CurrentSecond() ?? _position;UpdateExportSelection(); }
    private void OnClearSelection(object sender,RoutedEventArgs e) => ClearExportSelection();
    private void ClearExportSelection() { _exportStart=null;_exportEnd=null;UpdateExportSelection(); }
    private void UpdateExportSelection()
    {
        Timeline.Selection=_exportStart is {} start && _exportEnd is {} end && end>start ? (start,end) : null;
        Timeline.InvalidateVisual();
        string Clock(double? value)=>value.HasValue?TimeSpan.FromSeconds(Math.Floor(value.Value)).ToString(@"hh\:mm\:ss"):"--:--:--";
        SelectionText.Text=_exportStart is null && _exportEnd is null?"":Strings.T("evidence.selection",Clock(_exportStart),Clock(_exportEnd));
    }
}
