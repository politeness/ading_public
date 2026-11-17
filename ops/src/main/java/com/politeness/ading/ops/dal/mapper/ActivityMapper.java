package com.politeness.ading.ops.dal.mapper;

import com.politeness.ading.ops.dal.ActivitySessionRow;
import java.time.LocalDateTime;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/** Activity records (desktop foreground pings, mobile connections) and desktop online intervals, read-only. */
@Mapper
public interface ActivityMapper {
    @Select("SELECT MIN(s.started_at) FROM " + StatisticsScope.ACTIVITY + " s WHERE " + StatisticsScope.SESSION_S)
    LocalDateTime earliestStatHour();

    String ONLINE_WINDOW = " s.started_at < #{to} AND (s.ended_at > #{from} OR s.started_at = s.ended_at AND s.started_at >= #{from}) ";

    @Select("SELECT COUNT(DISTINCT s.device_uuid) FROM " + StatisticsScope.ACTIVITY + " s WHERE " + StatisticsScope.SESSION_S
            + " AND " + ONLINE_WINDOW)
    long countActiveDevices(@Param("from") LocalDateTime from, @Param("to") LocalDateTime to);

    @Select("SELECT COUNT(DISTINCT s.user_id) FROM " + StatisticsScope.ACTIVITY + " s JOIN users u ON u.user_id=s.user_id AND u.is_agent=0 WHERE "
            + StatisticsScope.SESSION_S + " AND " + ONLINE_WINDOW)
    long countActiveUsers(@Param("from") LocalDateTime from, @Param("to") LocalDateTime to);

    @Select("SELECT s.device_uuid, s.user_id, s.device_type, s.started_at AS online_at, s.ended_at FROM " + StatisticsScope.ACTIVITY + " s WHERE "
            + StatisticsScope.SESSION_S + " AND " + ONLINE_WINDOW)
    List<ActivitySessionRow> sessions(@Param("from") LocalDateTime from, @Param("to") LocalDateTime to);

    /** Desktop online intervals overlapping the window, used only to compute duration for active desktops */
    @Select("SELECT s.device_uuid, s.user_id, s.device_type, s.started_at AS online_at, s.ended_at FROM " + StatisticsScope.DESKTOP_CONNECTIONS + " s WHERE "
            + StatisticsScope.SESSION_S + " AND " + ONLINE_WINDOW)
    List<ActivitySessionRow> desktopConnections(@Param("from") LocalDateTime from, @Param("to") LocalDateTime to);

}
