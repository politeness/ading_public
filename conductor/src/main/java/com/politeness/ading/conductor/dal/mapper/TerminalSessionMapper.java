package com.politeness.ading.conductor.dal.mapper;

import java.time.LocalDateTime;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * terminal_sessions: one row per MQTT connection. The pre-release and release processes write the same table at once, so every statement must survive the other one getting there first:
 * opening merges via the open_terminal_id unique key; closing is conditional and skips if the other process just recorded a connection.
 */
@Mapper
public interface TerminalSessionMapper {

    record OpenSession(String terminalId, LocalDateTime lastSeenAt) {}

    @Select("SELECT terminal_id, last_seen_at FROM terminal_sessions WHERE open_terminal_id IS NOT NULL")
    List<OpenSession> findOpen();

    @Insert("""
            INSERT INTO terminal_sessions (terminal_id, device_uuid, user_id, online_at, last_seen_at, open_terminal_id)
            VALUES (#{terminalId}, #{deviceUuid}, #{userId}, #{at}, #{at}, #{terminalId})
            ON DUPLICATE KEY UPDATE last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at))
            """)
    int open(@Param("terminalId") String terminalId, @Param("deviceUuid") String deviceUuid,
             @Param("userId") String userId, @Param("at") LocalDateTime at);

    @Update("""
            UPDATE terminal_sessions SET last_seen_at = #{at}
             WHERE open_terminal_id = #{terminalId} AND last_seen_at < #{at}
            """)
    int touch(@Param("terminalId") String terminalId, @Param("at") LocalDateTime at);

    /**
     * Ends an open session. A null offlineAt means the disconnect time was not observed; the last observed connection time is used.
     * observedAt is the time of this observation: if another process recorded a connection after it, the terminal has reconnected and this close is skipped.
     */
    @Update("""
            UPDATE terminal_sessions
               SET offline_at = COALESCE(#{offlineAt}, last_seen_at), open_terminal_id = NULL
             WHERE open_terminal_id = #{terminalId} AND last_seen_at <= #{observedAt}
            """)
    int close(@Param("terminalId") String terminalId, @Param("offlineAt") LocalDateTime offlineAt,
              @Param("observedAt") LocalDateTime observedAt);
}
