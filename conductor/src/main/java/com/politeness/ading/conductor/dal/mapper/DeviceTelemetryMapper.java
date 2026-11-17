package com.politeness.ading.conductor.dal.mapper;

import java.time.LocalDateTime;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface DeviceTelemetryMapper {

    /** Unique by device_uuid: inserted the first time, afterwards the whole row is updated with the latest report. */
    @Insert("""
            INSERT INTO device_telemetry
              (device_uuid, user_id, device_type, phone, email, city, agents, last_report_at)
            VALUES
              (#{deviceUuid}, #{userId}, #{deviceType}, #{phone}, #{email}, #{city}, #{agents}, #{reportedAt})
            ON DUPLICATE KEY UPDATE
              user_id = VALUES(user_id), device_type = VALUES(device_type), phone = VALUES(phone),
              email = VALUES(email), city = VALUES(city), agents = VALUES(agents),
              last_report_at = VALUES(last_report_at)
            """)
    int upsert(@Param("deviceUuid") String deviceUuid,
               @Param("userId") String userId,
               @Param("deviceType") String deviceType,
               @Param("phone") String phone,
               @Param("email") String email,
               @Param("city") String city,
               @Param("agents") String agents,
               @Param("reportedAt") LocalDateTime reportedAt);

    /**
     * This device was in the foreground during this hourly bucket. Unique by (stat_hour, device_uuid); a repeat report in the same hour only updates account and time;
     * the ops console computes DAU and MAU from this table.
     */
    @Insert("""
            INSERT INTO device_telemetry_hour (stat_hour, device_uuid, user_id, device_type, reported_at)
            VALUES (#{statHour}, #{deviceUuid}, #{userId}, #{deviceType}, #{reportedAt})
            ON DUPLICATE KEY UPDATE
              user_id = VALUES(user_id), device_type = VALUES(device_type), reported_at = VALUES(reported_at)
            """)
    int upsertHour(@Param("statHour") LocalDateTime statHour,
                   @Param("deviceUuid") String deviceUuid,
                   @Param("userId") String userId,
                   @Param("deviceType") String deviceType,
                   @Param("reportedAt") LocalDateTime reportedAt);
}
