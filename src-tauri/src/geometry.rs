//! Native desktop geometry. All positions and sizes here are physical pixels;
//! only the preferred 780-pixel webview width starts in logical CSS pixels.
use serde::Serialize;

pub const LOGICAL_PANEL_WIDTH: f64 = 780.0;
pub const ALIGNMENT_TOLERANCE: i64 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Extent {
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub position: Point,
    pub size: Extent,
}
impl Rect {
    pub fn right(self) -> i64 {
        i64::from(self.position.x) + i64::from(self.size.width)
    }
    pub fn bottom(self) -> i64 {
        i64::from(self.position.y) + i64::from(self.size.height)
    }
    pub fn valid(self) -> bool {
        self.size.width > 0 && self.size.height > 0
    }
    fn contains(self, x: f64, y: f64) -> bool {
        self.valid()
            && x >= f64::from(self.position.x)
            && x < self.right() as f64
            && y >= f64::from(self.position.y)
            && y < self.bottom() as f64
    }
    fn distance_squared(self, x: f64, y: f64) -> f64 {
        let dx = (f64::from(self.position.x) - x)
            .max(0.0)
            .max(x - self.right() as f64);
        let dy = (f64::from(self.position.y) - y)
            .max(0.0)
            .max(y - self.bottom() as f64);
        dx * dx + dy * dy
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorGeometry {
    pub name: Option<String>,
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale_factor: f64,
}
impl MonitorGeometry {
    /// Some desktop APIs expose a desktop-wide work area. Intersect it with
    /// this monitor so a neighboring display cannot move our right-edge rail.
    pub fn usable_area(&self) -> Option<Rect> {
        if !self.bounds.valid() {
            return None;
        }
        let left = i64::from(self.bounds.position.x).max(i64::from(self.work_area.position.x));
        let top = i64::from(self.bounds.position.y).max(i64::from(self.work_area.position.y));
        let right = self.bounds.right().min(self.work_area.right());
        let bottom = self.bounds.bottom().min(self.work_area.bottom());
        if self.work_area.valid() && right > left && bottom > top {
            Some(Rect {
                position: Point {
                    x: left as i32,
                    y: top as i32,
                },
                size: Extent {
                    width: (right - left) as u32,
                    height: (bottom - top) as u32,
                },
            })
        } else {
            Some(self.bounds)
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Placement {
    pub position: Point,
    pub size: Extent,
}

pub fn desired_placement(monitor: &MonitorGeometry) -> Option<Placement> {
    let area = monitor.usable_area()?;
    let scale = if monitor.scale_factor.is_finite() && monitor.scale_factor > 0.0 {
        monitor.scale_factor
    } else {
        1.0
    };
    let width = (LOGICAL_PANEL_WIDTH * scale)
        .round()
        .clamp(1.0, f64::from(area.size.width)) as u32;
    let size = Extent {
        width,
        height: area.size.height,
    };
    Some(Placement {
        position: anchored_origin(area, size),
        size,
    })
}
/// Reanchor against the actual OS-reported outer width, not the requested width.
/// A resize can be asynchronous, constrained, or rounded by the window manager.
pub fn anchored_origin(area: Rect, actual_outer: Extent) -> Point {
    Point {
        x: (area.right() - i64::from(actual_outer.width))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y: area.position.y,
    }
}
pub fn right_edge_error(area: Rect, origin: Point, outer: Extent) -> i64 {
    i64::from(origin.x) + i64::from(outer.width) - area.right()
}
pub fn placement_matches(
    area: Rect,
    desired: Placement,
    origin: Point,
    outer: Extent,
    inner: Extent,
) -> bool {
    right_edge_error(area, origin, outer).abs() <= ALIGNMENT_TOLERANCE
        && (i64::from(origin.y) - i64::from(area.position.y)).abs() <= ALIGNMENT_TOLERANCE
        && (i64::from(inner.width) - i64::from(desired.size.width)).abs() <= ALIGNMENT_TOLERANCE
        && (i64::from(inner.height) - i64::from(desired.size.height)).abs() <= ALIGNMENT_TOLERANCE
}
/// Monitor names are not unique (two identical models often share a name).
/// Only a unique name may survive an origin change without ambiguity.
pub fn matching_monitor(monitors: &[MonitorGeometry], previous: &MonitorGeometry) -> Option<usize> {
    if let Some(index) = monitors
        .iter()
        .position(|m| m.name == previous.name && m.bounds.position == previous.bounds.position)
    {
        return Some(index);
    }
    let name = previous.name.as_ref()?;
    let mut matches = monitors
        .iter()
        .enumerate()
        .filter(|(_, m)| m.name.as_ref() == Some(name));
    let first = matches.next()?.0;
    if matches.next().is_none() {
        Some(first)
    } else {
        None
    }
}
/// Cursor-monitor selection uses physical virtual-desktop origins, including
/// negative coordinates. A cursor in a monitor gap chooses the nearest display.
pub fn select_monitor(
    monitors: &[MonitorGeometry],
    cursor: Option<(f64, f64)>,
    current: Option<usize>,
    primary: Option<usize>,
) -> Option<usize> {
    if let Some((x, y)) = cursor.filter(|(x, y)| x.is_finite() && y.is_finite()) {
        if let Some(index) = monitors.iter().position(|m| m.bounds.contains(x, y)) {
            return Some(index);
        }
        if let Some((index, _)) = monitors
            .iter()
            .enumerate()
            .filter(|(_, m)| m.bounds.valid())
            .min_by(|(_, a), (_, b)| {
                a.bounds
                    .distance_squared(x, y)
                    .total_cmp(&b.bounds.distance_squared(x, y))
            })
        {
            return Some(index);
        }
    }
    current
        .filter(|i| monitors.get(*i).is_some_and(|m| m.bounds.valid()))
        .or_else(|| primary.filter(|i| monitors.get(*i).is_some_and(|m| m.bounds.valid())))
        .or_else(|| monitors.iter().position(|m| m.bounds.valid()))
}
/// This is an app-local GTK preference, not an OS setting. An explicit user
/// backend is never replaced. GTK tries the available X server, then any other
/// compiled backend instead of failing startup when a stale DISPLAY is present.
pub fn linux_backend_preference(
    display: Option<&str>,
    explicit_backend: Option<&str>,
) -> Option<&'static str> {
    if explicit_backend.is_none() && display.is_some_and(|value| !value.trim().is_empty()) {
        Some("x11,*")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn monitor(x: i32, y: i32, width: u32, height: u32, scale: f64) -> MonitorGeometry {
        let bounds = Rect {
            position: Point { x, y },
            size: Extent { width, height },
        };
        MonitorGeometry {
            name: None,
            bounds,
            work_area: bounds,
            scale_factor: scale,
        }
    }
    #[test]
    fn standard_and_ultrawide_anchor_to_physical_screen_right() {
        for (w, h, expected_x) in [(1440, 1000, 660), (3440, 1440, 2660)] {
            let m = monitor(0, 0, w, h, 1.0);
            let p = desired_placement(&m).unwrap();
            assert_eq!(
                p.position,
                Point {
                    x: expected_x,
                    y: 0
                }
            );
            assert_eq!(
                p.size,
                Extent {
                    width: 780,
                    height: h
                }
            );
            assert_eq!(right_edge_error(m.work_area, p.position, p.size), 0);
        }
    }
    #[test]
    fn hidpi_converts_width_once_and_preserves_physical_monitor_origin() {
        let m = monitor(2880, 100, 2880, 1800, 2.0);
        let p = desired_placement(&m).unwrap();
        assert_eq!(
            p.size,
            Extent {
                width: 1560,
                height: 1800
            }
        );
        assert_eq!(p.position, Point { x: 4200, y: 100 });
        assert_eq!(right_edge_error(m.work_area, p.position, p.size), 0);
    }
    #[test]
    fn fractional_scaling_rounds_only_logical_width() {
        let m = monitor(-1920, 0, 1920, 1080, 1.25);
        let p = desired_placement(&m).unwrap();
        assert_eq!(p.size.width, 975);
        assert_eq!(p.position.x, -975);
    }
    #[test]
    fn negative_monitor_origins_and_reserved_panels_are_preserved() {
        let mut m = monitor(-1920, -1080, 1920, 1080, 1.0);
        m.work_area = Rect {
            position: Point { x: -1920, y: -1048 },
            size: Extent {
                width: 1880,
                height: 1048,
            },
        };
        let p = desired_placement(&m).unwrap();
        assert_eq!(p.position, Point { x: -820, y: -1048 });
        assert_eq!(p.size.height, 1048);
    }
    #[test]
    fn virtual_desktop_workarea_is_intersected_with_selected_display() {
        let mut m = monitor(1920, 0, 2560, 1440, 1.0);
        m.work_area = Rect {
            position: Point { x: 0, y: 30 },
            size: Extent {
                width: 4480,
                height: 1410,
            },
        };
        let p = desired_placement(&m).unwrap();
        assert_eq!(p.position, Point { x: 3700, y: 30 });
        assert_eq!(p.size.height, 1410);
    }
    #[test]
    fn actual_outer_width_not_requested_width_determines_final_position() {
        let m = monitor(0, 0, 1440, 1000, 1.0);
        let desired = desired_placement(&m).unwrap();
        let actual_outer = Extent {
            width: 800,
            height: 1000,
        };
        let origin = anchored_origin(m.work_area, actual_outer);
        assert_eq!(desired.position.x, 660);
        assert_eq!(origin.x, 640);
        assert!(placement_matches(
            m.work_area,
            desired,
            origin,
            actual_outer,
            desired.size
        ));
        assert!(!placement_matches(
            m.work_area,
            desired,
            desired.position,
            actual_outer,
            desired.size
        ));
    }
    #[test]
    fn small_screen_never_requests_a_wider_client() {
        let m = monitor(10, 20, 320, 480, 2.0);
        let p = desired_placement(&m).unwrap();
        assert_eq!(p.position, Point { x: 10, y: 20 });
        assert_eq!(
            p.size,
            Extent {
                width: 320,
                height: 480
            }
        );
    }
    #[test]
    fn cursor_selects_scaled_neighbor_in_physical_coordinates() {
        let monitors = vec![
            monitor(-1920, 0, 1920, 1080, 1.0),
            monitor(0, 0, 3840, 2160, 2.0),
        ];
        assert_eq!(
            select_monitor(&monitors, Some((-100.0, 100.0)), Some(1), Some(1)),
            Some(0)
        );
        assert_eq!(
            select_monitor(&monitors, Some((3000.0, 1500.0)), Some(0), Some(0)),
            Some(1)
        );
        assert_eq!(
            select_monitor(&monitors, Some((0.0, 10.0)), Some(0), Some(0)),
            Some(1)
        );
    }
    #[test]
    fn cursor_gap_uses_nearest_monitor_and_missing_cursor_uses_current_then_primary() {
        let monitors = vec![
            monitor(0, 0, 1000, 800, 1.0),
            monitor(2000, 0, 1000, 800, 1.0),
        ];
        assert_eq!(
            select_monitor(&monitors, Some((1900.0, 200.0)), Some(0), Some(0)),
            Some(1)
        );
        assert_eq!(select_monitor(&monitors, None, Some(1), Some(0)), Some(1));
        assert_eq!(select_monitor(&monitors, None, None, Some(0)), Some(0));
        assert_eq!(
            select_monitor(&monitors, Some((f64::NAN, 0.0)), Some(1), Some(0)),
            Some(1)
        );
    }
    #[test]
    fn invalid_bounds_fail_safely_and_invalid_workarea_uses_screen() {
        assert!(desired_placement(&monitor(0, 0, 0, 0, 1.0)).is_none());
        let mut m = monitor(0, 0, 1440, 1000, 1.0);
        m.work_area = Rect {
            position: Point { x: 9000, y: 9000 },
            size: Extent {
                width: 500,
                height: 500,
            },
        };
        assert_eq!(
            desired_placement(&m).unwrap().position,
            Point { x: 660, y: 0 }
        );
    }
    #[test]
    fn identical_monitor_names_never_retarget_a_show_by_name_alone() {
        let mut first = monitor(0, 0, 1920, 1080, 1.0);
        first.name = Some("Identical Display".into());
        let mut second = monitor(1920, 0, 1920, 1080, 1.0);
        second.name = first.name.clone();
        let mut moved = first.clone();
        moved.bounds.position.x = -1920;
        moved.work_area.position.x = -1920;
        assert_eq!(
            matching_monitor(&[first.clone(), second.clone()], &second),
            Some(1)
        );
        assert_eq!(matching_monitor(&[first.clone(), second], &moved), None);
        assert_eq!(matching_monitor(&[first], &moved), Some(0));
    }
    #[test]
    fn app_local_x11_preference_respects_user_and_missing_server() {
        assert_eq!(linux_backend_preference(Some(":0"), None), Some("x11,*"));
        for explicit in ["wayland", "x11", "wayland,x11", ""] {
            assert_eq!(linux_backend_preference(Some(":0"), Some(explicit)), None);
        }
        assert_eq!(linux_backend_preference(None, None), None);
        assert_eq!(linux_backend_preference(Some(""), None), None);
    }
}
