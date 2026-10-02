using System;
using System.Globalization;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// Paints a camera's status dot from <see cref="Models.V1Camera.Online"/>.
///
/// The three states are kept apart on screen, not collapsed to two. Unknown - no event heard for
/// this camera yet - is drawn in the border colour, which reads as "nothing to say", while offline
/// is red. An operator who cannot tell those apart will read a client that has just started as a
/// wall of dead cameras.
/// </summary>
public sealed class StatusDotConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        var key = value switch
        {
            "online" or true => "StatusOkBrush",
            "offline" or false => "StatusCritBrush",
            "edgeUnavailable" or "missing" or "awaitingStream" => "StatusWarnBrush",
            _ => "BorderBrush",
        };

        return Application.Current.TryFindResource(key) as Brush ?? Brushes.Gray;
    }

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
