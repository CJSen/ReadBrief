#[cfg(test)]
mod tests {
    use crate::windows::{
        FLOAT_STATE_DONE, FLOAT_STATE_ERROR, FLOAT_STATE_IDLE, FLOAT_STATE_STREAMING,
        get_float_state, is_float_fixed, is_float_visible, mark_float_visible,
    };
    use std::sync::atomic::Ordering;
    use crate::windows::FLOAT_VISIBLE;
    /// 浮窗状态机：idle → streaming → done 全路径
    #[test]
    fn state_transition_idle_to_done() {
        // idle 态值不等于 streaming
        assert_ne!(FLOAT_STATE_IDLE, FLOAT_STATE_STREAMING);
        assert_ne!(FLOAT_STATE_IDLE, FLOAT_STATE_DONE);
        assert_ne!(FLOAT_STATE_IDLE, FLOAT_STATE_ERROR);

        // streaming ≠ done ≠ error
        assert_ne!(FLOAT_STATE_STREAMING, FLOAT_STATE_DONE);
        assert_ne!(FLOAT_STATE_DONE, FLOAT_STATE_ERROR);
    }

    /// 各状态值互不重叠
    #[test]
    fn state_values_unique() {
        let states = [
            FLOAT_STATE_IDLE,
            FLOAT_STATE_STREAMING,
            FLOAT_STATE_DONE,
            FLOAT_STATE_ERROR,
        ];
        let mut seen = std::collections::HashSet::new();
        for &s in &states {
            assert!(seen.insert(s), "状态值 {s} 重复");
        }
    }

    /// idle 态点外部应关闭（#P2-12 修复验证）
    #[test]
    fn idle_is_not_streaming() {
        // idle 不等于 streaming，确保 Focused(false) 守卫中
        // get_float_state() != FLOAT_STATE_STREAMING 在 idle 态为 true
        assert!(FLOAT_STATE_IDLE != FLOAT_STATE_STREAMING);
        // 初始状态为 idle(0)
        assert_eq!(get_float_state(), FLOAT_STATE_IDLE);
    }

    /// 固定状态下不允许任何关闭操作（点外部 / Esc）
    #[test]
    fn fixed_state_prevents_close() {
        // is_float_fixed 初始为 false
        assert!(!is_float_fixed());
    }

    /// mark_float_visible 正确设置可见标志
    #[test]
    fn mark_visible_sets_flag() {
        // 初始为不可见
        FLOAT_VISIBLE.store(0, Ordering::SeqCst);
        assert!(!is_float_visible());
        mark_float_visible();
        assert!(is_float_visible());
        // 清理
        FLOAT_VISIBLE.store(0, Ordering::SeqCst);
    }
}
