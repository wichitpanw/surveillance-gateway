using System;
using System.ComponentModel;
using System.Windows;
using System.Windows.Media;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>Which page a tab holds. The shell keeps at most one tab per kind.</summary>
public enum PageKind
{
    Home,
    Wall,
    Map,
    Devices,
    Events,
    Playback,
}

/// <summary>
/// One tab in the strip.
///
/// A tab is not the page: the page's view is built once and kept alive whether or not its tab is
/// selected, so a wall someone arranged is still arranged after a trip to the map. Closing a tab
/// is what tears the view down, and that is also what stops its decoders.
/// </summary>
public sealed class PageTabModel : INotifyPropertyChanged, IDisposable
{
    private bool _isSelected;

    public PageTabModel(PageKind kind, string titleKey, bool canClose)
    {
        Kind = kind;
        TitleKey = titleKey;
        CanClose = canClose;

        // The title follows the language, so it is re-read rather than captured.
        Strings.Current.LanguageChanged += OnLanguageChanged;
    }

    private void OnLanguageChanged(object? sender, EventArgs e) => Raise(nameof(Title));

    /// <summary>Detaches from Strings.Current; the shell calls it when the tab is closed or cleared.</summary>
    public void Dispose() => Strings.Current.LanguageChanged -= OnLanguageChanged;

    public PageKind Kind { get; }

    public string TitleKey { get; }

    public bool CanClose { get; }

    public string Title => Strings.T(TitleKey);

    public Visibility CloseVisibility => CanClose ? Visibility.Visible : Visibility.Collapsed;

    public bool IsSelected
    {
        get => _isSelected;
        set
        {
            if (_isSelected == value) return;
            _isSelected = value;
            Raise(nameof(IsSelected));
            Raise(nameof(Marker));
        }
    }

    /// <summary>
    /// The dot in front of the tab name.
    ///
    /// Brand yellow on the selected tab, faint otherwise. On a wall display read from across a
    /// room, the fill difference between a selected and unselected pill is not visible; the dot is.
    /// </summary>
    public Brush Marker =>
        (Application.Current.TryFindResource(_isSelected ? "BrandYellowBrush" : "FaintForegroundBrush") as Brush)
        ?? Brushes.Gray;

    public event PropertyChangedEventHandler? PropertyChanged;

    private void Raise(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
